"""Profile-scoped, read-only query bridge for OpenUI ``Query`` tools."""

from __future__ import annotations

import ipaddress
import json
import re
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

PLUGIN_ID = "hermes-openui"
QUERY_TOOL = "query_data"
QUERY_TOKEN_ENV = "HERMES_OPENUI_QUERY_TOKEN"
QUERY_TIMEOUT_SECONDS = 10.0
MAX_ARGUMENT_COUNT = 32
MAX_ARGUMENT_TEXT = 2_000
MAX_ARRAY_VALUES = 50
MAX_RESPONSE_BYTES = 1_000_000
MAX_ROWS = 5_000
ARGUMENT_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")

router = APIRouter()


class QueryRequest(BaseModel):
    arguments: dict[str, Any] = Field(default_factory=dict)


def _settings() -> dict[str, Any]:
    from hermes_cli.config import load_config_readonly

    config = load_config_readonly() or {}
    plugins = config.get("plugins")
    entries = plugins.get("entries") if isinstance(plugins, dict) else None
    entry = entries.get(PLUGIN_ID) if isinstance(entries, dict) else None
    settings = entry.get("settings") if isinstance(entry, dict) else None
    return settings if isinstance(settings, dict) else {}


def _is_loopback(host: str | None) -> bool:
    if not host:
        return False
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _query_url() -> str:
    raw = _settings().get("query_url")
    value = raw.strip() if isinstance(raw, str) else ""

    if not value:
        raise HTTPException(
            status_code=409,
            detail="Configure plugins.entries.hermes-openui.settings.query_url before using query_data.",
        )

    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or (parsed.scheme == "http" and not _is_loopback(parsed.hostname))
    ):
        raise HTTPException(
            status_code=409,
            detail="query_url must be a credential-free HTTPS URL; HTTP is limited to loopback hosts.",
        )

    return value


def _query_parameters(arguments: dict[str, Any]) -> list[tuple[str, str]]:
    if len(arguments) > MAX_ARGUMENT_COUNT:
        raise HTTPException(status_code=400, detail="query_data received too many arguments.")

    parameters: list[tuple[str, str]] = []
    for name, raw_value in arguments.items():
        if not ARGUMENT_NAME_RE.fullmatch(name):
            raise HTTPException(status_code=400, detail=f"Invalid query argument name: {name!r}.")

        values = raw_value if isinstance(raw_value, list) else [raw_value]
        if len(values) > MAX_ARRAY_VALUES:
            raise HTTPException(status_code=400, detail=f"Query argument {name!r} has too many values.")

        for value in values:
            if value is None:
                text = ""
            elif isinstance(value, (str, int, float, bool)):
                text = str(value).lower() if isinstance(value, bool) else str(value)
            else:
                raise HTTPException(
                    status_code=400,
                    detail=f"Query argument {name!r} must contain only scalar values.",
                )

            if len(text) > MAX_ARGUMENT_TEXT:
                raise HTTPException(status_code=400, detail=f"Query argument {name!r} is too long.")
            parameters.append((name, text))

    return parameters


def _with_parameters(url: str, parameters: list[tuple[str, str]]) -> str:
    parsed = urlsplit(url)
    query = parse_qsl(parsed.query, keep_blank_values=True)
    query.extend(parameters)
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), ""))


def _token() -> str:
    try:
        from agent.secret_scope import get_secret

        value = get_secret(QUERY_TOKEN_ENV, "")
    except Exception:
        value = ""
    return value.strip() if isinstance(value, str) else ""


async def _read_query(arguments: dict[str, Any]) -> dict[str, Any]:
    url = _query_url()
    parameters = _query_parameters(arguments)
    headers = {"Accept": "application/json", "User-Agent": "hermes-openui/0.1"}
    token = _token()
    if token:
        headers["Authorization"] = f"Bearer {token}"

    try:
        async with httpx.AsyncClient(
            timeout=QUERY_TIMEOUT_SECONDS,
            follow_redirects=False,
        ) as client:
            response = await client.get(_with_parameters(url, parameters), headers=headers)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Configured query source failed: {type(exc).__name__}.")

    if 300 <= response.status_code < 400:
        raise HTTPException(status_code=502, detail="Configured query source returned a redirect; redirects are refused.")
    if response.status_code < 200 or response.status_code >= 300:
        raise HTTPException(
            status_code=502,
            detail=f"Configured query source returned HTTP {response.status_code}.",
        )
    if len(response.content) > MAX_RESPONSE_BYTES:
        raise HTTPException(status_code=502, detail="Configured query source exceeded the 1 MB response limit.")

    try:
        value = response.json()
    except (json.JSONDecodeError, ValueError):
        raise HTTPException(status_code=502, detail="Configured query source did not return JSON.")

    if not isinstance(value, dict) or not isinstance(value.get("rows"), list):
        raise HTTPException(
            status_code=502,
            detail='Configured query source must return a JSON object with a "rows" array.',
        )
    if len(value["rows"]) > MAX_ROWS:
        raise HTTPException(status_code=502, detail="Configured query source exceeded the 5000-row limit.")
    if not all(isinstance(row, dict) for row in value["rows"]):
        raise HTTPException(status_code=502, detail='Every item in "rows" must be a JSON object.')

    return value


@router.get("/capabilities")
async def capabilities() -> dict[str, Any]:
    configured = False
    try:
        _query_url()
        configured = True
    except HTTPException:
        pass
    return {QUERY_TOOL: {"configured": configured}}


@router.post("/query")
async def query(request: QueryRequest) -> dict[str, Any]:
    return await _read_query(request.arguments)
