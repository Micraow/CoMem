from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from unittest.mock import patch


def _load_provider():
    path = Path(__file__).parents[1] / "__init__.py"
    spec = importlib.util.spec_from_file_location("comem_hermes_provider", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class FakeCoMem:
    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.session_status = 200
        self.fail_capture = False
        self.fail_context = False
        self.fail_identity = False
        self.redirect_next = False
        self.subject = "user:demo"
        self.context_rendered = "Known: project mint"
        self.context_items: list[dict[str, Any]] = [
            {"uri": "comem://user/demo/memory.md"}
        ]
        self.context_degradation: str | None = None
        self.lock = threading.Lock()
        test = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, _format, *args):
                pass

            def _read(self):
                length = int(self.headers.get("content-length", "0"))
                return json.loads(self.rfile.read(length) or b"")

            def _send(self, status: int, body: dict[str, Any]):
                encoded = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def do_GET(self):
                with test.lock:
                    test.requests.append(
                        {"method": "GET", "path": self.path, "auth": self.headers.get("authorization")}
                    )
                    redirect = test.redirect_next
                    test.redirect_next = False
                if redirect:
                    self.send_response(302)
                    self.send_header("location", "https://example.invalid/redirected")
                    self.send_header("content-length", "0")
                    self.end_headers()
                    return
                if self.path == "/api/v1/auth/me":
                    if test.fail_identity:
                        return self._send(
                            503,
                            {
                                "status": "error",
                                "error": {"code": "UNAVAILABLE", "message": "offline"},
                            },
                        )
                    return self._send(
                        200,
                        {
                            "status": "ok",
                            "result": {
                                "subject": test.subject,
                                "principals": [test.subject],
                            },
                        },
                    )
                if self.path == "/api/v1/sessions/hermes-session":
                    return self._send(
                        200,
                        {
                            "status": "ok",
                            "result": {"messageCount": 0, "lastCommitAt": "2026-01-01T00:00:00Z"},
                        },
                    )
                return self._send(404, {"status": "error", "error": {"code": "NOT_FOUND"}})

            def do_POST(self):
                body = self._read()
                with test.lock:
                    test.requests.append(
                        {
                            "method": "POST",
                            "path": self.path,
                            "body": body,
                            "auth": self.headers.get("authorization"),
                        }
                    )
                if test.fail_capture and self.path != "/api/v1/context":
                    return self._send(
                        503,
                        {"status": "error", "error": {"code": "UNAVAILABLE", "message": "offline"}},
                    )
                if self.path == "/api/v1/context":
                    if test.fail_context:
                        return self._send(
                            503,
                            {"status": "error", "error": {"code": "UNAVAILABLE", "message": "offline"}},
                        )
                    return self._send(
                        200,
                        {
                            "status": "ok",
                            "result": {
                                "rendered": test.context_rendered,
                                "items": test.context_items,
                                "deliveryToken": "receipt-one",
                                "degradation": test.context_degradation,
                            },
                        },
                    )
                if self.path == "/api/v1/sessions":
                    if test.session_status == 409:
                        return self._send(
                            409,
                            {
                                "status": "error",
                                "error": {"code": "ALREADY_EXISTS", "message": "exists"},
                            },
                        )
                    return self._send(
                        200,
                        {"status": "ok", "result": {"uri": "comem://user/demo/sessions/id"}},
                    )
                if self.path.endswith("/commit"):
                    if body == {"ambiguous": True}:
                        return self._send(
                            400,
                            {
                                "status": "error",
                                "error": {"code": "INVALID_ARGUMENT", "message": "empty"},
                            },
                        )
                    return self._send(
                        200,
                        {
                            "status": "ok",
                            "result": {"taskId": "task", "archivedCount": 2},
                        },
                    )
                if self.path.endswith("/messages"):
                    return self._send(
                        200,
                        {"status": "ok", "result": {"count": len(body.get("messages", []))}},
                    )
                return self._send(404, {"status": "error", "error": {"code": "NOT_FOUND"}})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}/api/v1"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class ProviderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = _load_provider()
        self.api = FakeCoMem()
        self.home = tempfile.TemporaryDirectory()
        self.provider = self.module.CoMemMemoryProvider(
            {"base_url": self.api.base_url, "token": "test-token"}
        )
        self.provider.initialize(
            "native-session",
            hermes_home=self.home.name,
            agent_identity="desktop",
            cwd="/work",
            agent_context="primary",
        )

    def tearDown(self) -> None:
        self.api.close()
        self.home.cleanup()

    def test_prefetch_uses_context_and_marks_recall(self) -> None:
        rendered = self.provider.prefetch("How should I name the project?")
        self.assertEqual(rendered, "Known: project mint")
        self.assertEqual(self.provider.recall_status().count, 1)
        context = next(r for r in self.api.requests if r["path"] == "/api/v1/context")
        self.assertEqual(
            context["body"]["sessionId"],
            self.provider._session_id_of("native-session"),
        )
        self.assertEqual(context["auth"], "Bearer test-token")
        self.assertEqual(
            context["body"]["budgetMs"],
            self.module._PREFETCH_BUDGET_MS,
        )

    def test_prefetch_status_records_non_secret_transport_metadata(self) -> None:
        self.api.context_degradation = "rerank_unavailable"
        rendered = self.provider.prefetch("How should I name the project?")
        status = self.provider.get_status_config({})
        recall = status["last_recall"]
        context = next(r for r in self.api.requests if r["path"] == "/api/v1/context")

        self.assertEqual(recall["outcome"], "received")
        self.assertEqual(
            recall["session_id"],
            self.provider._session_id_of("native-session"),
        )
        self.assertEqual(recall["count"], 1)
        self.assertEqual(recall["bytes"], len(rendered.encode("utf-8")))
        self.assertEqual(recall["degradation"], "rerank_unavailable")
        self.assertEqual(recall["budget_ms"], context["body"]["budgetMs"])
        self.assertEqual(recall["timeout_s"], self.module._PREFETCH_TIMEOUT_S)
        self.assertTrue(recall["at"].endswith("Z"))

        raw_status = (
            self.provider._state_dir / "status.json"
        ).read_text(encoding="utf-8")
        self.assertNotIn("How should I name the project?", raw_status)
        self.assertNotIn(rendered, raw_status)
        self.assertNotIn("test-token", raw_status)

        restarted = self.module.CoMemMemoryProvider(
            {"base_url": self.api.base_url, "token": "test-token"}
        )
        restarted.initialize("native-session", hermes_home=self.home.name)
        self.assertEqual(restarted.get_status_config({})["last_recall"], recall)

    def test_prefetch_status_distinguishes_empty_recall(self) -> None:
        self.api.context_rendered = ""
        self.api.context_items = []
        self.assertEqual(self.provider.prefetch("no matches"), "")

        recall = self.provider.get_status_config({})["last_recall"]
        self.assertEqual(recall["outcome"], "empty")
        self.assertEqual(recall["count"], 0)
        self.assertEqual(recall["bytes"], 0)
        self.assertIsNone(recall["degradation"])

    def test_prefetch_status_distinguishes_failure(self) -> None:
        self.api.fail_context = True
        self.assertEqual(self.provider.prefetch("offline"), "")

        status = self.provider.get_status_config({})
        recall = status["last_recall"]
        self.assertEqual(recall["outcome"], "failed")
        self.assertEqual(recall["count"], 0)
        self.assertEqual(recall["bytes"], 0)
        self.assertEqual(recall["budget_ms"], self.module._PREFETCH_BUDGET_MS)
        self.assertEqual(recall["timeout_s"], self.module._PREFETCH_TIMEOUT_S)
        self.assertTrue(status["last_error"].startswith("recall:"))

    def test_queue_prefetch_does_not_issue_a_speculative_request(self) -> None:
        self.provider.queue_prefetch("completed turn", session_id="native-session")
        self.assertEqual(
            [r for r in self.api.requests if r["path"] == "/api/v1/context"], []
        )
        self.provider.prefetch("current prompt", session_id="native-session")
        contexts = [r for r in self.api.requests if r["path"] == "/api/v1/context"]
        self.assertEqual(len(contexts), 1)
        self.assertEqual(contexts[0]["body"]["query"], "current prompt")

    def test_live_prefetch_uses_the_current_epoch(self) -> None:
        self.provider.on_session_switch("native-session", rewound=True)
        current_epoch = self.provider._epoch
        self.provider.queue_prefetch("completed turn", session_id="native-session")
        self.provider.prefetch("current prompt", session_id="native-session")
        contexts = [r for r in self.api.requests if r["path"] == "/api/v1/context"]
        self.assertEqual(len(contexts), 1)
        self.assertEqual(contexts[0]["body"]["contextEpoch"], current_epoch)

    def test_next_live_prefetch_acknowledges_delivery_receipt(self) -> None:
        self.provider.prefetch("first")
        self.provider.sync_turn(
            "first",
            "answer",
            session_id="native-session",
            messages=[
                {"role": "user", "content": "first"},
                {"role": "assistant", "content": "answer"},
            ],
        )
        self.provider.prefetch("follow-up", session_id="native-session")
        requests = [r for r in self.api.requests if r["path"] == "/api/v1/context"]
        self.assertEqual(requests[-1]["body"]["previousDeliveryToken"], "receipt-one")

    def test_capture_is_stable_and_excludes_recall_fence(self) -> None:
        messages = [
            {"role": "user", "content": "project alpha", "timestamp": "2026-01-01T00:00:00Z"},
            {"role": "assistant", "content": "stored", "timestamp": "2026-01-01T00:00:00Z"},
        ]
        first = self.provider._turn_record(
            "native-session",
            "project alpha",
            "stored",
            [
                {
                    "role": "user",
                    "content": "project alpha <memory-context>old fact</memory-context>",
                    "timestamp": "2026-01-01T00:00:00Z",
                },
                {
                    "role": "assistant",
                    "content": "stored",
                    "timestamp": "2026-01-01T00:00:00Z",
                },
            ],
        )
        second = self.provider._turn_record("native-session", "project alpha", "stored", messages)
        self.assertEqual(first["messages"], second["messages"])
        self.assertNotIn("old fact", json.dumps(first))
        self.assertEqual(list(self.provider._outbox_dir.glob("*.json")), [])

    def test_message_ids_do_not_depend_on_transcript_position(self) -> None:
        current = [
            {"role": "user", "content": "project alpha", "timestamp": "2026-01-01T00:00:00Z"},
            {"role": "assistant", "content": "stored", "timestamp": "2026-01-01T00:00:01Z"},
        ]
        prefixed = [{"role": "system", "content": "older context"}] + current
        original = self.provider._turn_record(
            "native-session", "project alpha", "stored", current
        )
        moved = self.provider._turn_record(
            "native-session", "project alpha", "stored", prefixed
        )
        self.assertEqual(original["messages"], moved["messages"])

    def test_numeric_hermes_timestamps_are_preserved(self) -> None:
        record = self.provider._turn_record(
            "native-session",
            "project alpha",
            "stored",
            [
                {
                    "role": "user",
                    "content": "project alpha",
                    "timestamp": 1767225600.125,
                },
                {
                    "role": "assistant",
                    "content": "stored",
                    "timestamp": 1767225601.5,
                },
            ],
        )
        self.assertEqual(record["messages"][0]["createdAt"], "2026-01-01T00:00:00.125000Z")
        self.assertEqual(record["messages"][1]["createdAt"], "2026-01-01T00:00:01.500000Z")

    def test_recall_and_capture_use_the_same_comem_session_id(self) -> None:
        messages = [
            {"role": "user", "content": "project alpha"},
            {"role": "assistant", "content": "stored"},
        ]
        self.provider.prefetch("project alpha", session_id="native-session")
        self.provider.sync_turn(
            "project alpha",
            "stored",
            session_id="native-session",
            messages=messages,
        )
        context = next(r for r in self.api.requests if r["path"] == "/api/v1/context")
        create = next(r for r in self.api.requests if r["path"] == "/api/v1/sessions")
        canonical = self.provider._session_id_of("native-session")
        self.assertEqual(context["body"]["sessionId"], canonical)
        self.assertEqual(create["body"]["sessionId"], canonical)
        self.assertTrue(
            any(r["path"] == f"/api/v1/sessions/{canonical}/messages" for r in self.api.requests)
        )

    def test_sync_turn_writes_create_append_and_commit(self) -> None:
        self.provider.sync_turn(
            "project alpha",
            "stored",
            messages=[
                {"role": "user", "content": "project alpha"},
                {"role": "assistant", "content": "stored"},
            ],
        )
        paths = [r["path"] for r in self.api.requests]
        self.assertTrue(any(path == "/api/v1/sessions" for path in paths))
        self.assertTrue(any(path.endswith("/messages") for path in paths))
        self.assertTrue(any(path.endswith("/commit") for path in paths))
        ids = {
            message["id"]
            for request in self.api.requests
            if request["path"].endswith("/messages")
            for message in request["body"]["messages"]
        }
        self.assertEqual(len(ids), 2)
        self.assertTrue(all(value.startswith("hermes-") for value in ids))

    def test_existing_session_is_reused(self) -> None:
        self.api.session_status = 409
        self.provider.sync_turn(
            "project alpha",
            "stored",
            messages=[
                {"role": "user", "content": "project alpha"},
                {"role": "assistant", "content": "stored"},
            ],
        )
        self.assertTrue(any(r["path"].endswith("/commit") for r in self.api.requests))
        self.assertEqual(list(self.provider._outbox_dir.glob("*.json")), [])

    def test_failed_capture_spools_and_retries(self) -> None:
        self.api.fail_capture = True
        self.provider.sync_turn(
            "project alpha",
            "stored",
            messages=[
                {"role": "user", "content": "project alpha"},
                {"role": "assistant", "content": "stored"},
            ],
        )
        self.assertEqual(len(list(self.provider._outbox_dir.glob("*.json"))), 1)
        self.api.fail_capture = False
        self.provider._flush_outbox()
        self.assertEqual(list(self.provider._outbox_dir.glob("*.json")), [])

    def test_known_account_keeps_outage_capture_bound_across_restart(self) -> None:
        self.provider.sync_turn(
            "first",
            "answer",
            messages=[
                {"role": "user", "content": "first"},
                {"role": "assistant", "content": "answer"},
            ],
        )
        self.api.fail_capture = True
        self.api.fail_identity = True
        self.provider.sync_turn(
            "second",
            "answer two",
            messages=[
                {"role": "user", "content": "second"},
                {"role": "assistant", "content": "answer two"},
            ],
        )
        path = next(self.provider._outbox_dir.glob("*.json"))
        record = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(record["binding"]["subject"], "user:demo")

        self.api.fail_capture = False
        self.api.fail_identity = False
        restarted = self.module.CoMemMemoryProvider(
            {"base_url": self.api.base_url, "token": "test-token"}
        )
        restarted.initialize("native-session", hermes_home=self.home.name)
        restarted._flush_outbox()
        self.assertEqual(list(self.provider._outbox_dir.glob("*.json")), [])

    def test_outbox_does_not_store_the_api_token(self) -> None:
        self.api.fail_capture = True
        self.provider.sync_turn(
            "project alpha",
            "stored",
            messages=[
                {"role": "user", "content": "project alpha"},
                {"role": "assistant", "content": "stored"},
            ],
        )
        path = next(self.provider._outbox_dir.glob("*.json"))
        payload = path.read_text(encoding="utf-8")
        self.assertNotIn("test-token", payload)
        self.assertIn(self.provider._settings.binding_id, payload)

    def test_outbox_is_not_replayed_after_credential_change(self) -> None:
        self.api.fail_capture = True
        self.provider.sync_turn(
            "project alpha",
            "stored",
            messages=[
                {"role": "user", "content": "project alpha"},
                {"role": "assistant", "content": "stored"},
            ],
        )
        before = sum(
            r["method"] == "POST" and r["path"] == "/api/v1/sessions"
            for r in self.api.requests
        )
        self.api.fail_capture = False
        other = self.module.CoMemMemoryProvider(
            {"base_url": self.api.base_url, "token": "other-test-token"}
        )
        other.initialize("native-session", hermes_home=self.home.name)
        other._flush_outbox()
        after = sum(
            r["method"] == "POST" and r["path"] == "/api/v1/sessions"
            for r in self.api.requests
        )
        self.assertEqual(before, after)
        self.assertEqual(len(list(self.provider._outbox_dir.glob("*.json"))), 1)

    def test_outbox_is_not_replayed_after_account_change(self) -> None:
        self.api.fail_capture = True
        self.provider.sync_turn(
            "project alpha",
            "stored",
            messages=[
                {"role": "user", "content": "project alpha"},
                {"role": "assistant", "content": "stored"},
            ],
        )
        before = sum(
            r["method"] == "POST" and r["path"] == "/api/v1/sessions"
            for r in self.api.requests
        )
        self.api.fail_capture = False
        self.api.subject = "user:other"
        other = self.module.CoMemMemoryProvider(
            {"base_url": self.api.base_url, "token": "test-token"}
        )
        other.initialize("native-session", hermes_home=self.home.name)
        other._flush_outbox()
        after = sum(
            r["method"] == "POST" and r["path"] == "/api/v1/sessions"
            for r in self.api.requests
        )
        self.assertEqual(before, after)
        self.assertEqual(len(list(self.provider._outbox_dir.glob("*.json"))), 1)

    def test_outbox_is_not_replayed_after_endpoint_change(self) -> None:
        self.api.fail_capture = True
        self.provider.sync_turn(
            "project alpha",
            "stored",
            messages=[
                {"role": "user", "content": "project alpha"},
                {"role": "assistant", "content": "stored"},
            ],
        )
        other_api = FakeCoMem()
        try:
            other = self.module.CoMemMemoryProvider(
                {"base_url": other_api.base_url, "token": "test-token"}
            )
            other.initialize("native-session", hermes_home=self.home.name)
            other._flush_outbox()
            self.assertFalse(
                any(
                    r["method"] == "POST" and r["path"] == "/api/v1/sessions"
                    for r in other_api.requests
                )
            )
        finally:
            other_api.close()
        self.assertEqual(len(list(self.provider._outbox_dir.glob("*.json"))), 1)

    def test_foreign_records_do_not_starve_matching_backlog(self) -> None:
        wrong_binding = {
            "endpoint": self.api.base_url,
            "transport": "wrong-transport",
            "subject": "user:other",
        }
        for index in range(10):
            record = self.provider._turn_record(
                "native-session",
                f"old {index}",
                f"response {index}",
                [
                    {
                        "role": "user",
                        "content": f"old {index}",
                        "timestamp": f"2026-01-01T00:{index:02d}:00Z",
                    },
                    {
                        "role": "assistant",
                        "content": f"response {index}",
                        "timestamp": f"2026-01-01T00:{index:02d}:01Z",
                    },
                ],
            )
            record["binding"] = wrong_binding
            self.provider._spool(record)
        matching = self.provider._turn_record(
            "native-session",
            "current",
            "answer",
            [
                {
                    "role": "user",
                    "content": "current",
                    "timestamp": "2026-01-02T00:00:00Z",
                },
                {
                    "role": "assistant",
                    "content": "answer",
                    "timestamp": "2026-01-02T00:00:01Z",
                },
            ],
        )
        matching["binding"] = {
            "endpoint": self.api.base_url,
            "transport": self.provider._settings.binding_id,
            "subject": "user:demo",
        }
        self.provider._spool(matching)

        self.provider._flush_outbox(expected_subject="user:demo")

        remaining = {path.name for path in self.provider._outbox_dir.glob("*.json")}
        self.assertEqual(len(remaining), 10)
        self.assertNotIn(matching["id"], " ".join(remaining))
        self.assertEqual(
            sum(
                r["method"] == "POST" and r["path"] == "/api/v1/sessions"
                for r in self.api.requests
            ),
            1,
        )

    def test_reset_changes_context_epoch(self) -> None:
        before = self.provider._epoch
        self.provider.on_session_switch("new-session", reset=True)
        self.assertNotEqual(self.provider._epoch, before)
        self.assertTrue(self.provider._epoch.startswith("reset-"))

    def test_rewind_changes_context_epoch(self) -> None:
        before = self.provider._epoch
        self.provider.on_session_switch("native-session", rewound=True)
        self.assertNotEqual(self.provider._epoch, before)
        self.assertTrue(self.provider._epoch.startswith("rewound-"))

    def test_status_reports_pending_writes_and_subject_before_initialize(self) -> None:
        home = tempfile.TemporaryDirectory()
        try:
            outbox = Path(home.name) / "comem-provider" / "outbox"
            outbox.mkdir(parents=True)
            (outbox / "one.json").write_text("", encoding="utf-8")
            (outbox.parent / "status.json").write_text(
                json.dumps({"lastError": "recall: offline"}), encoding="utf-8"
            )
            provider = self.module.CoMemMemoryProvider(
                {"base_url": self.api.base_url, "token": "test-token"}
            )
            (outbox.parent / "binding.json").write_text(
                json.dumps(
                    {
                        "transport": provider._settings.binding_id,
                        "subject": "user:demo",
                    }
                ),
                encoding="utf-8",
            )
            with patch.dict(os.environ, {"HERMES_HOME": home.name}):
                status = provider.get_status_config({})
            self.assertEqual(status["pending_writes"], 1)
            self.assertEqual(status["subject"], "user:demo")
            self.assertEqual(status["last_error"], "recall: offline")
        finally:
            home.cleanup()

    def test_status_omits_subject_bound_to_old_credentials(self) -> None:
        home = tempfile.TemporaryDirectory()
        try:
            state_dir = Path(home.name) / "comem-provider"
            state_dir.mkdir(parents=True)
            (state_dir / "binding.json").write_text(
                json.dumps(
                    {
                        "transport": "old-transport",
                        "subject": "user:old",
                    }
                ),
                encoding="utf-8",
            )
            provider = self.module.CoMemMemoryProvider(
                {"base_url": self.api.base_url, "token": "new-test-token"}
            )
            with patch.dict(os.environ, {"HERMES_HOME": home.name}):
                status = provider.get_status_config({})
            self.assertNotIn("subject", status)
        finally:
            home.cleanup()

    def test_outbox_names_sort_chronologically(self) -> None:
        first = self.provider._turn_record(
            "native-session",
            "first",
            "one",
            [
                {"role": "user", "content": "first", "timestamp": "2026-01-01T00:00:00Z"},
                {"role": "assistant", "content": "one", "timestamp": "2026-01-01T00:00:01Z"},
            ],
        )
        second = self.provider._turn_record(
            "native-session",
            "second",
            "two",
            [
                {"role": "user", "content": "second", "timestamp": "2026-01-01T00:01:00Z"},
                {"role": "assistant", "content": "two", "timestamp": "2026-01-01T00:01:01Z"},
            ],
        )
        self.provider._spool(second)
        self.provider._spool(first)
        paths = sorted(self.provider._outbox_dir.glob("*.json"))
        self.assertIn(first["id"], paths[0].name)
        self.assertIn(second["id"], paths[1].name)

    def test_server_root_is_accepted(self) -> None:
        provider = self.module.CoMemMemoryProvider({"base_url": "http://127.0.0.1:1933"})
        self.assertEqual(provider._settings.base_url, "http://127.0.0.1:1933/api/v1")

    def test_config_schema_recommends_console_account_key(self) -> None:
        schema = {
            field["key"]: field
            for field in self.module.CoMemMemoryProvider().get_config_schema()
        }
        token = schema["token"]
        self.assertEqual(token["env_var"], "COMEM_TOKEN")
        self.assertIn("same account", token["description"])
        self.assertIn("loopback", token["description"])

    def test_no_explicit_config_reads_the_active_hermes_profile(self) -> None:
        home = tempfile.TemporaryDirectory()
        try:
            Path(home.name, "config.yaml").write_text(
                "memory:\n"
                "  provider: comem\n"
                "  comem:\n"
                "    base_url: http://127.0.0.1:19572/api/v1\n"
                "    max_tokens: 2048\n",
                encoding="utf-8",
            )
            with patch.dict(
                os.environ,
                {"HERMES_HOME": home.name, "COMEM_BASE_URL": ""},
            ):
                provider = self.module.CoMemMemoryProvider()
                self.assertEqual(
                    provider._settings.base_url,
                    "http://127.0.0.1:19572/api/v1",
                )
                self.assertEqual(provider._settings.max_tokens, 2048)
                self.assertEqual(
                    provider.get_status_config({})["endpoint"],
                    "http://127.0.0.1:19572/api/v1",
                )
        finally:
            home.cleanup()

    def test_message_route_quotes_session_id(self) -> None:
        self.provider._client.ensure_session("../unsafe")
        create = next(r for r in self.api.requests if r["path"] == "/api/v1/sessions")
        self.assertEqual(create["body"]["sessionId"], "../unsafe")

    def test_no_credentials_needed_for_loopback(self) -> None:
        provider = self.module.CoMemMemoryProvider({"base_url": "http://127.0.0.1:1933"})
        self.assertTrue(provider.is_available())
        remote = self.module.CoMemMemoryProvider({"base_url": "https://mem.example.test"})
        self.assertFalse(remote.is_available())
        self.assertIn("COMEM_TOKEN", remote.unavailable_reason())

    def test_embedded_credentials_are_rejected(self) -> None:
        provider = self.module.CoMemMemoryProvider(
            {"base_url": "https://user:pass@mem.example.test", "token": "test-token"}
        )
        self.assertFalse(provider.is_available())
        self.assertIn("without embedded credentials", provider.unavailable_reason())

    def test_malformed_url_fails_as_configuration_not_import(self) -> None:
        provider = self.module.CoMemMemoryProvider({"base_url": "http://["})
        self.assertFalse(provider.is_available())
        self.assertIn("HTTP(S)", provider.unavailable_reason())

    def test_redirects_are_not_followed(self) -> None:
        self.api.redirect_next = True
        with self.assertRaises(self.module._HttpFailure) as raised:
            self.provider._client.identity()
        self.assertEqual(raised.exception.status, 302)


if __name__ == "__main__":
    unittest.main()
