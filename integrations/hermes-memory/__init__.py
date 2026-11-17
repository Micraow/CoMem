"""CoMem memory provider for Hermes Agent.

The provider owns only transport and lifecycle adaptation. CoMem remains the
source of truth for automatic recall, archive, extraction, merge and review.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import logging
import math
import os
import re
import threading
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from agent.memory_provider import MemoryProvider, RecallStatus
from agent.secret_scope import get_secret

logger = logging.getLogger(__name__)

_DEFAULT_BASE_URL = "http://127.0.0.1:1933/api/v1"
_PREFETCH_BUDGET_MS = 7500
_PREFETCH_TIMEOUT_S = 7.5
_CAPTURE_TIMEOUT_S = 4.0
_PROCESS_OUTBOX_LIMIT = 10
_MAX_CONTEXT_TOKENS = 1200
_MAX_CONTEXT_BYTES = 8000
_RECALL_TAG = re.compile(
    r"<\s*(?:memory-context|comem-recall|comem-profile|comem-preferences)\s*>.*?"
    r"<\s*/\s*(?:memory-context|comem-recall|comem-profile|comem-preferences)\s*>",
    re.IGNORECASE | re.DOTALL,
)


def _strip_recall(text: str) -> str:
    lines = [line for line in _RECALL_TAG.sub("", text).splitlines() if line.strip()]
    return "\n".join(lines).strip()


def _iso_time(value: Any, fallback: datetime) -> str:
    parsed: datetime | None = None
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        if math.isfinite(value):
            try:
                return datetime.fromtimestamp(value, UTC).isoformat().replace("+00:00", "Z")
            except (OverflowError, OSError, ValueError):
                pass
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            try:
                numeric = float(value)
            except ValueError:
                numeric = None
            if numeric is not None and math.isfinite(numeric):
                try:
                    return datetime.fromtimestamp(numeric, UTC).isoformat().replace("+00:00", "Z")
                except (OverflowError, OSError, ValueError):
                    pass
    if parsed is not None:
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        return parsed.astimezone(UTC).isoformat().replace("+00:00", "Z")
    return fallback.isoformat().replace("+00:00", "Z")


def _message_text(message: dict[str, Any]) -> str:
    content = message.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            str(part.get("text", ""))
            for part in content
            if isinstance(part, dict) and part.get("type") in {"text", "input_text", "output_text"}
        ).strip()
    return ""


def _find_last(messages: list[dict[str, Any]], role: str, text: str, start: int = 0) -> int:
    for index in range(len(messages) - 1, start - 1, -1):
        message = messages[index]
        if message.get("role") == role and _strip_recall(_message_text(message)) == text:
            return index
    return -1


def _is_loopback(url: str) -> bool:
    try:
        host = (urllib.parse.urlsplit(url).hostname or "").lower()
    except ValueError:
        return False
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _valid_http_url(url: str) -> bool:
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    return (
        parsed.scheme in {"http", "https"}
        and bool(parsed.hostname)
        and parsed.username is None
        and parsed.password is None
    )


def _config_block() -> dict[str, Any]:
    try:
        from hermes_cli.config import load_config_readonly

        memory = load_config_readonly().get("memory", {})
        block = memory.get("comem", {}) if isinstance(memory, dict) else {}
        return dict(block) if isinstance(block, dict) else {}
    except Exception:
        return {}


def _env_or_config(env_name: str, config: dict[str, Any], key: str, default: str = "") -> str:
    try:
        value = get_secret(env_name, "")
    except TypeError:
        value = get_secret(env_name)
    except Exception:
        value = ""
    return str(value or config.get(key) or default)


@dataclass(frozen=True)
class _Settings:
    base_url: str
    token: str
    max_tokens: int
    binding_id: str


def _settings(config: dict[str, Any] | None = None) -> _Settings:
    block = _config_block() if config is None else config
    base_url = _env_or_config("COMEM_BASE_URL", block, "base_url", _DEFAULT_BASE_URL).rstrip("/")
    try:
        has_api_path = urllib.parse.urlsplit(base_url).path.rstrip("/").endswith("/api/v1")
    except ValueError:
        has_api_path = True
    if not has_api_path:
        base_url = f"{base_url}/api/v1"
    token = _env_or_config("COMEM_TOKEN", block, "token")
    raw_tokens = block.get("max_tokens", _MAX_CONTEXT_TOKENS)
    try:
        max_tokens = min(16000, max(1, int(raw_tokens)))
    except (TypeError, ValueError):
        max_tokens = _MAX_CONTEXT_TOKENS
    auth_binding = token if token else "loopback"
    binding_id = hashlib.sha256(
        "\0".join(("comem-hermes", base_url, auth_binding)).encode("utf-8")
    ).hexdigest()[:20]
    return _Settings(
        base_url=base_url,
        token=token,
        max_tokens=max_tokens,
        binding_id=binding_id,
    )


class _HttpFailure(RuntimeError):
    def __init__(self, status: int | None, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


class _Client:
    def __init__(self, settings: _Settings):
        self._settings = settings

    def request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        *,
        timeout: float,
    ) -> dict[str, Any]:
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers = {"Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if self._settings.token:
            headers["Authorization"] = f"Bearer {self._settings.token}"
        request = urllib.request.Request(
            f"{self._settings.base_url}{path}", data=data, headers=headers, method=method
        )
        try:
            opener = urllib.request.build_opener(_NoRedirect())
            with opener.open(request, timeout=timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            raw = error.read().decode("utf-8", errors="replace")
            try:
                envelope = json.loads(raw)
                detail = envelope.get("error", {}) if isinstance(envelope, dict) else {}
                code = str(detail.get("code", "HTTP_ERROR"))
                message = str(detail.get("message", raw))
            except (json.JSONDecodeError, AttributeError):
                code, message = "HTTP_ERROR", raw or str(error)
            error.close()
            raise _HttpFailure(error.code, code, message) from error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise _HttpFailure(None, "UNAVAILABLE", str(error)) from error
        if not isinstance(payload, dict) or payload.get("status") != "ok":
            raise _HttpFailure(None, "INVALID_RESPONSE", "CoMem returned an invalid response envelope")
        result = payload.get("result")
        if not isinstance(result, dict):
            raise _HttpFailure(None, "INVALID_RESPONSE", "CoMem response has no result object")
        return result

    def context(
        self, query: str, session_id: str, epoch: str, previous_token: str
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "query": query,
            "sessionId": session_id,
            "contextEpoch": epoch,
            "maxTokens": self._settings.max_tokens,
            "maxBytes": _MAX_CONTEXT_BYTES,
            "budgetMs": _PREFETCH_BUDGET_MS,
        }
        if previous_token:
            body["previousDeliveryToken"] = previous_token
        return self.request("POST", "/context", body, timeout=_PREFETCH_TIMEOUT_S)

    def identity(self) -> dict[str, Any]:
        return self.request("GET", "/auth/me", timeout=_CAPTURE_TIMEOUT_S)

    def ensure_session(self, session_id: str) -> None:
        try:
            self.request(
                "POST", "/sessions", {"sessionId": session_id}, timeout=_CAPTURE_TIMEOUT_S
            )
        except _HttpFailure as error:
            if error.status != 409 or error.code != "ALREADY_EXISTS":
                raise

    def append(self, session_id: str, messages: list[dict[str, Any]]) -> None:
        encoded = urllib.parse.quote(session_id, safe="")
        self.request(
            "POST",
            f"/sessions/{encoded}/messages",
            {"messages": messages},
            timeout=_CAPTURE_TIMEOUT_S,
        )

    def commit(self, session_id: str) -> None:
        encoded = urllib.parse.quote(session_id, safe="")
        try:
            self.request(
                "POST", f"/sessions/{encoded}/commit", {}, timeout=_CAPTURE_TIMEOUT_S
            )
        except _HttpFailure as error:
            if error.status != 400 or error.code != "INVALID_ARGUMENT":
                raise
            session = self.request(
                "GET", f"/sessions/{encoded}", timeout=_CAPTURE_TIMEOUT_S
            )
            if session.get("messageCount") != 0 or session.get("lastCommitAt") is None:
                raise


class CoMemMemoryProvider(MemoryProvider):
    """Automatic CoMem recall and completed-turn capture for one Hermes profile."""

    def __init__(self, config: dict[str, Any] | None = None):
        self._config = dict(config) if config is not None else {}
        self._settings = _settings(config)
        self._client = _Client(self._settings)
        self._session_id = ""
        self._epoch = "default"
        self._agent_context = "primary"
        self._cwd = ""
        self._machine_id = "hermes"
        self._state_dir: Path | None = None
        self._outbox_dir: Path | None = None
        self._known_subject = ""
        self._lock = threading.RLock()
        self._pending_delivery: dict[str, str] = {}
        self._delivered: dict[str, str] = {}
        self._recall = 0
        self._last_error = ""

    @property
    def name(self) -> str:
        return "comem"

    def is_available(self) -> bool:
        return _valid_http_url(self._settings.base_url) and (
            bool(self._settings.token) or _is_loopback(self._settings.base_url)
        )

    def unavailable_reason(self) -> str:
        if not _valid_http_url(self._settings.base_url):
            return "Set COMEM_BASE_URL to an HTTP(S) CoMem API root without embedded credentials."
        if not self._settings.token and not _is_loopback(self._settings.base_url):
            return "Set COMEM_TOKEN for a non-loopback CoMem endpoint."
        return self._last_error

    @staticmethod
    def _read_binding(state_dir: Path | None) -> dict[str, Any]:
        if state_dir is None:
            return {}
        try:
            binding = json.loads((state_dir / "binding.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return binding if isinstance(binding, dict) else {}

    def _bound_subject(self, state_dir: Path | None) -> str:
        binding = self._read_binding(state_dir)
        subject = binding.get("subject")
        if binding.get("transport") != self._settings.binding_id:
            return ""
        return subject if isinstance(subject, str) else ""

    def initialize(self, session_id: str, **kwargs) -> None:
        home = Path(kwargs.get("hermes_home") or Path.home() / ".hermes")
        self._state_dir = home / "comem-provider"
        self._outbox_dir = self._state_dir / "outbox"
        try:
            self._state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            self._outbox_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        except OSError as error:
            self._outbox_dir = None
            self._record_failure("state directory", error)
        self._known_subject = self._bound_subject(self._state_dir)
        self._session_id = session_id
        self._agent_context = str(kwargs.get("agent_context") or "primary")
        self._cwd = str(kwargs.get("cwd") or "")
        identity = str(kwargs.get("agent_identity") or "hermes")
        self._machine_id = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:16]
        self._epoch = f"hermes-{kwargs.get('resumed', False)}-{kwargs.get('message_count', 0)}"

    def get_config_schema(self) -> list[dict[str, Any]]:
        return [
            {
                "key": "base_url",
                "label": "CoMem API address",
                "description": "CoMem API root, ending in /api/v1.",
                "default": _DEFAULT_BASE_URL,
                "required": True,
            },
            {
                "key": "token",
                "label": "CoMem API key",
                "description": (
                    "Recommended: a CoMem API key for the same account you use in the CoMem "
                    "console. Leave empty only for a loopback endpoint with loopback trust; "
                    "that mode uses the server's configured subject."
                ),
                "secret": True,
                "env_var": "COMEM_TOKEN",
            },
            {
                "key": "max_tokens",
                "label": "Automatic recall budget",
                "description": "Maximum tokens CoMem may include in one automatic recall.",
                "type": "integer",
                "default": _MAX_CONTEXT_TOKENS,
                "minimum": 1,
                "maximum": 16000,
                "step": 100,
            },
        ]

    def get_tool_schemas(self) -> list[dict[str, Any]]:
        """Automatic recall and capture need no extra model-facing tools."""
        return []

    def save_config(self, values: dict[str, Any], hermes_home: str) -> None:
        from hermes_cli.config import load_config, save_config

        config = load_config()
        memory = config.setdefault("memory", {})
        block = memory.setdefault("comem", {})
        for key in ("base_url", "max_tokens"):
            if key in values and values[key] not in (None, ""):
                block[key] = values[key]
        save_config(config)

    def get_status_config(self, _values: dict[str, Any]) -> dict[str, Any]:
        pending = 0
        outbox = self._outbox_dir
        state_dir = self._state_dir
        if outbox is None:
            try:
                from hermes_constants import get_hermes_home

                state_dir = get_hermes_home() / "comem-provider"
                outbox = state_dir / "outbox"
            except Exception:
                outbox = None
        if outbox is not None and outbox.exists():
            pending = len(list(outbox.glob("*.json")))
        last_error = self._last_error
        if not last_error and state_dir is not None:
            try:
                stored = json.loads((state_dir / "status.json").read_text(encoding="utf-8"))
                if isinstance(stored, dict):
                    last_error = str(stored.get("lastError") or "")
            except (OSError, json.JSONDecodeError):
                pass
        if self._settings.token:
            authentication = "API key"
        elif _is_loopback(self._settings.base_url):
            authentication = "loopback trust"
        else:
            authentication = "not configured (remote endpoint requires an API key)"
        subject = self._known_subject or self._bound_subject(state_dir)
        result = {
            "endpoint": self._settings.base_url,
            "authentication": authentication,
            "recall_max_tokens": self._settings.max_tokens,
            "pending_writes": pending,
        }
        if subject:
            result["subject"] = subject
        if last_error:
            result["last_error"] = last_error
        return result

    def recall_status(self) -> RecallStatus | None:
        if self._recall <= 0:
            return None
        return RecallStatus(provider_label="CoMem", count=self._recall, glyph="◈")

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        """Recall must use the upcoming prompt; Hermes only supplies the completed prompt here."""

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        sid = session_id or self._session_id
        with self._lock:
            epoch = self._epoch
            previous = self._delivered.get(sid, "")
        try:
            result = self._client.context(
                query, self._session_id_of(sid), epoch, previous
            )
            items = result.get("items")
            rendered = str(result.get("rendered") or "")
            count = len(items) if isinstance(items, list) else 0
            token = str(result.get("deliveryToken") or "")
        except Exception as error:
            self._record_failure("recall", error)
            with self._lock:
                self._recall = 0
            return ""
        self._recall = count
        with self._lock:
            if token:
                self._pending_delivery[sid] = token
            else:
                self._pending_delivery.pop(sid, None)
        return rendered

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
        messages: list[dict[str, Any]] | None = None,
        turn_author: dict[str, Any] | None = None,
    ) -> None:
        sid = session_id or self._session_id
        with self._lock:
            delivered = self._pending_delivery.pop(sid, "")
            if delivered:
                self._delivered[sid] = delivered
        if self._agent_context != "primary" or not sid:
            return
        user = _strip_recall(user_content)
        assistant = _strip_recall(assistant_content)
        if not user or not assistant:
            return
        try:
            record = self._turn_record(sid, user, assistant, messages or [])
            try:
                identity = self._client.identity()
                subject = identity.get("subject")
                if not isinstance(subject, str) or not subject:
                    raise ValueError("CoMem /auth/me returned no subject")
                self._remember_subject(subject)
            except Exception as error:
                subject = self._known_subject
                self._record_failure("identity", error)
            record["binding"] = {
                "endpoint": self._settings.base_url,
                "transport": self._settings.binding_id,
                "subject": subject,
            }
            self._spool(record)
            if subject:
                self._flush_outbox(expected_subject=subject)
        except Exception as error:
            self._record_failure("capture", error)

    def on_session_switch(
        self,
        new_session_id: str,
        *,
        parent_session_id: str = "",
        reset: bool = False,
        rewound: bool = False,
        **kwargs,
    ) -> None:
        with self._lock:
            self._session_id = new_session_id
            self._pending_delivery.clear()
            self._delivered.clear()
            if reset or rewound:
                boundary = "rewound" if rewound else "reset"
                self._epoch = f"{boundary}-{datetime.now(UTC).isoformat()}"

    def _turn_record(
        self,
        native_session: str,
        user: str,
        assistant: str,
        transcript: list[dict[str, Any]],
    ) -> dict[str, Any]:
        session_id = self._session_id_of(native_session)
        user_index = _find_last(transcript, "user", user)
        assistant_index = _find_last(
            transcript, "assistant", assistant, max(0, user_index + 1)
        )
        if assistant_index < 0:
            assistant_index = max(0, user_index + 1)
        epoch = datetime(1970, 1, 1, tzinfo=UTC)
        source = {
            "host": "hermes",
            "machineId": self._machine_id,
            "cwd": self._cwd,
        }
        captured: list[dict[str, Any]] = []
        for role, text, index in (("user", user, user_index), ("assistant", assistant, assistant_index)):
            source_message = (
                transcript[index]
                if 0 <= index < len(transcript) and isinstance(transcript[index], dict)
                else {}
            )
            created_at = _iso_time(
                source_message.get("timestamp")
                or source_message.get("createdAt")
                or source_message.get("created_at"),
                epoch + timedelta(milliseconds=max(0, index)),
            )
            digest = hashlib.sha256(
                "\0".join(("hermes", session_id, role, text, created_at)).encode("utf-8")
            ).hexdigest()
            captured.append(
                {
                    "id": f"hermes-{digest}",
                    "role": role,
                    "parts": [{"kind": "text", "text": text}],
                    "createdAt": created_at,
                    "source": source,
                }
            )
        turn_digest = hashlib.sha256(
            json.dumps(captured, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()
        return {"id": turn_digest, "session_id": session_id, "messages": captured}

    @staticmethod
    def _session_id_of(native_session: str) -> str:
        digest = hashlib.sha256(native_session.encode("utf-8")).hexdigest()[:32]
        return f"hermes-{digest}"

    def _spool(self, record: dict[str, Any]) -> None:
        if self._outbox_dir is None:
            raise RuntimeError("CoMem provider is not initialized")
        created_at = str(record["messages"][0]["createdAt"])
        path = self._outbox_dir / f"{created_at.replace(':', '')}-{record['id']}.json"
        self._atomic_json_write(path, record)

    @staticmethod
    def _atomic_json_write(path: Path, value: dict[str, Any]) -> None:
        temporary = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
        data = json.dumps(value, ensure_ascii=False, sort_keys=True).encode("utf-8")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            if temporary.exists():
                temporary.unlink()

    def _flush_outbox(self, *, expected_subject: str = "") -> None:
        if self._outbox_dir is None:
            return
        paths = sorted(self._outbox_dir.glob("*.json"))
        if not paths:
            return
        if expected_subject:
            subject = expected_subject
        else:
            try:
                identity = self._client.identity()
                subject = identity.get("subject")
                if not isinstance(subject, str) or not subject:
                    raise ValueError("CoMem /auth/me returned no subject")
                self._remember_subject(subject)
            except Exception as error:
                self._record_failure("identity", error)
                return
        processed = 0
        for path in paths:
            if processed >= _PROCESS_OUTBOX_LIMIT:
                logger.debug("CoMem capture backlog remains; the next completed turn will continue it")
                break
            record = json.loads(path.read_text(encoding="utf-8"))
            session_id = str(record["session_id"])
            messages = record["messages"]
            if not isinstance(messages, list):
                raise ValueError(f"invalid CoMem outbox record: {path.name}")
            binding = record.get("binding")
            if not isinstance(binding, dict):
                self._record_failure(
                    "outbox",
                    ValueError(f"{path.name} has no account binding and was not replayed"),
                )
                continue
            if (
                binding.get("endpoint") != self._settings.base_url
                or binding.get("transport") != self._settings.binding_id
                or binding.get("subject") != subject
            ):
                self._record_failure(
                    "outbox",
                    ValueError(
                        f"{path.name} belongs to a different CoMem endpoint, credential, "
                        "or account and was not replayed"
                    ),
                )
                continue
            self._client.ensure_session(session_id)
            self._client.append(session_id, messages)
            self._client.commit(session_id)
            path.unlink(missing_ok=True)
            processed += 1

    def _remember_subject(self, subject: str) -> None:
        self._known_subject = subject
        if self._state_dir is None:
            return
        try:
            self._state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            self._atomic_json_write(
                self._state_dir / "binding.json",
                {
                    "transport": self._settings.binding_id,
                    "subject": subject,
                },
            )
        except OSError:
            pass

    def _record_failure(self, operation: str, error: Exception) -> None:
        self._last_error = f"{operation}: {error}"
        if self._state_dir is not None:
            try:
                self._state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
                self._atomic_json_write(
                    self._state_dir / "status.json",
                    {
                        "lastError": self._last_error,
                        "at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                    },
                )
            except OSError:
                pass
        logger.warning("CoMem memory %s failed (Hermes continues): %s", operation, error)


def register(ctx) -> None:
    ctx.register_memory_provider(CoMemMemoryProvider())
