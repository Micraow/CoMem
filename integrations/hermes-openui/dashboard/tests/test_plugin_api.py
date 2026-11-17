from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from fastapi import HTTPException


MODULE_PATH = Path(__file__).resolve().parents[1] / "plugin_api.py"
SPEC = importlib.util.spec_from_file_location("hermes_openui_plugin_api", MODULE_PATH)
assert SPEC and SPEC.loader
plugin_api = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(plugin_api)


class FakeResponse:
    def __init__(self, value: object, status_code: int = 200) -> None:
        self.content = repr(value).encode()
        self.status_code = status_code
        self.value = value

    def json(self) -> object:
        return self.value


class FakeAsyncClient:
    response = FakeResponse({"rows": []})
    instances: list["FakeAsyncClient"] = []

    def __init__(self, **kwargs: object) -> None:
        self.kwargs = kwargs
        self.request: tuple[str, dict[str, str]] | None = None
        self.instances.append(self)

    async def __aenter__(self) -> "FakeAsyncClient":
        return self

    async def __aexit__(self, *args: object) -> None:
        return None

    async def get(self, url: str, headers: dict[str, str]) -> FakeResponse:
        self.request = (url, headers)
        return self.response


class QueryBridgeTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        FakeAsyncClient.instances = []
        FakeAsyncClient.response = FakeResponse({"rows": []})
        self.client_patch = patch.object(plugin_api.httpx, "AsyncClient", FakeAsyncClient)
        self.settings_patch = patch.object(
            plugin_api,
            "_settings",
            return_value={"query_url": "https://api.example.test/v1/rows?tenant=acme"},
        )
        self.token_patch = patch.object(plugin_api, "_token", return_value="profile-secret")
        self.client_patch.start()
        self.settings_patch.start()
        self.token_patch.start()

    def tearDown(self) -> None:
        self.token_patch.stop()
        self.settings_patch.stop()
        self.client_patch.stop()

    async def test_query_uses_only_configured_get_url_and_server_side_token(self) -> None:
        expected = {"rows": [{"id": "ORD-1042", "amount": 42}]}
        FakeAsyncClient.response = FakeResponse(expected)

        result = await plugin_api._read_query(
            {
                "method": "POST",
                "url": "https://attacker.example/collect",
                "window": "30d",
            }
        )

        self.assertEqual(result, expected)
        client = FakeAsyncClient.instances[0]
        self.assertEqual(
            client.kwargs,
            {"follow_redirects": False, "timeout": 10.0},
        )
        self.assertIsNotNone(client.request)
        url, headers = client.request
        parsed = urlsplit(url)
        self.assertEqual((parsed.scheme, parsed.hostname, parsed.path), (
            "https",
            "api.example.test",
            "/v1/rows",
        ))
        self.assertEqual(
            parse_qs(parsed.query),
            {
                "tenant": ["acme"],
                "method": ["POST"],
                "url": ["https://attacker.example/collect"],
                "window": ["30d"],
            },
        )
        self.assertEqual(headers["Authorization"], "Bearer profile-secret")

    async def test_redirect_and_malformed_rows_fail_closed(self) -> None:
        FakeAsyncClient.response = FakeResponse({"rows": []}, status_code=302)
        with self.assertRaisesRegex(HTTPException, "redirect") as redirect:
            await plugin_api._read_query({})
        self.assertEqual(redirect.exception.status_code, 502)

        FakeAsyncClient.response = FakeResponse({"items": []})
        with self.assertRaisesRegex(HTTPException, "rows") as missing_rows:
            await plugin_api._read_query({})
        self.assertEqual(missing_rows.exception.status_code, 502)

        FakeAsyncClient.response = FakeResponse({"rows": ["not-an-object"]})
        with self.assertRaisesRegex(HTTPException, "JSON object") as row_shape:
            await plugin_api._read_query({})
        self.assertEqual(row_shape.exception.status_code, 502)

    def test_query_url_validation_rejects_unsafe_schemes_and_credentials(self) -> None:
        cases = [
            "http://example.com/rows",
            "https://user:" + "not-a-real-password" + "@example.com/rows",
            "file:///tmp/rows.json",
            "https://example.com/rows#fragment",
        ]

        for value in cases:
            with self.subTest(value=value), patch.object(
                plugin_api, "_settings", return_value={"query_url": value}
            ):
                with self.assertRaises(HTTPException) as invalid:
                    plugin_api._query_url()
                self.assertEqual(invalid.exception.status_code, 409)

    async def test_capabilities_report_configuration_without_exposing_the_url(self) -> None:
        self.assertEqual(
            await plugin_api.capabilities(),
            {"query_data": {"configured": True}},
        )

        with patch.object(plugin_api, "_settings", return_value={}):
            self.assertEqual(
                await plugin_api.capabilities(),
                {"query_data": {"configured": False}},
            )


if __name__ == "__main__":
    unittest.main()
