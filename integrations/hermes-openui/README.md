# Streaming OpenUI for Hermes

A display plugin for the official Hermes v0.23.1 Webapp, maintained in CoMem. It renders interactive answers progressively in the chat. It uses the pinned Open Intelligent UI catalog (55 components and 59 functions); see [compatibility and limits](docs/PARITY.md) and the [original license](docs/OPEN-INTELLIGENT-UI-LICENSE.txt). Automatic CoMem memory uses a [separate plugin](../hermes-memory/README.md).

## Install and try it

From this directory:

```sh
npm ci
npm run build
```

The current bundle is about 3.0 MB, plus a 0.50 MB MapLibre worker. Hermes
v0.23.1's plugin reader accepts bundles up to 16 MiB. From this directory, link
the package into the home of the Hermes profile that serves the Webapp (the
default below is for an unprofiled install):

```sh
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
mkdir -p "$HERMES_HOME/plugins"
ln -s "$PWD" "$HERMES_HOME/plugins/hermes-openui"
hermes plugins doctor --ci "$PWD"
hermes plugins enable hermes-openui
```

Restart the Hermes gateway and reopen the Webapp. Enable **hermes-openui** from **Capabilities → Plugins**; Hermes leaves the browser half of unified packages off by default. In an existing chat, invoke `/hermes-openui:openui` followed by your request, for example: `Compare hybrid, semantic, and graph retrieval using clearly labeled illustrative scores, and let me switch the metric.` For a build update, rescan the installed plugins and reload the Webapp. See [PROTOCOL.md](docs/PROTOCOL.md) for the model output and deterministic provider fixture.

No Hermes patch is needed. The card appears as its source arrives; controls become available after the answer finishes. Hermes v0.23.1 can replace the transcript DOM at completion. The browser test measures whether the card stays visibly present and separately records whether Hermes reused its node.

The bundled examples cover a comparison with a local threshold, a cited brief, and a San Francisco answer with credited photos and a pannable OpenStreetMap map. Choosing a place moves the marker without asking the model. The map shows one place at a time and needs access to OpenStreetMap; a separate place link remains available. The model supplies source and photo URLs; the plugin checks them but does not verify claims, find photos, or compute routes. An unavailable photo retains its caption and source link.

### Configure a read-only Query source

`Query("query_data", args, {rows: []})` can load rows from one endpoint chosen
by the Hermes profile owner. Configure **Read-only query URL** on the plugin's
settings page. The equivalent non-secret configuration is:

```yaml
plugins:
  entries:
    hermes-openui:
      settings:
        query_url: "https://data.example.com/v1/rows"
```

Set **Query bearer token** in the same settings page when the endpoint needs a
bearer credential. Hermes stores it in the profile's `.env` under
`HERMES_OPENUI_QUERY_TOKEN`; it is never sent to the browser or entered into
the model transcript.

The upstream endpoint must accept `GET` and return:

```json
{"rows": [{"region": "North", "amount": 42}]}
```

The argument object supplied to `Query` becomes URL query parameters. For
example, `{"window": "30d", "region": ["North", "South"]}` adds
`window=30d&region=North&region=South`. The configured URL is the only
destination the browser bridge can call.

HTTPS is required. HTTP is accepted only for loopback hosts so a local service
can be tested. URLs with embedded credentials and fragments are rejected. The
bridge does not follow redirects, waits up to 10 seconds, accepts at most 1 MB
and 5,000 rows, and rejects responses without a `rows` array of objects.

When no URL is configured or the request fails, the card shows a visible data
error with a retry control. Dashboard rows are never replaced with synthetic
fixtures in normal model output. Any fixture used in screenshots or tests must
be labeled as demo data.

## Use CoMem from the same chat

For automatic recall and capture, follow the [Hermes quickstart](../../docs/hermes-quickstart.md). To let Hermes use explicit CoMem tools (including history import), add its MCP server to the profile's `config.yaml`. This example assumes both processes are on the same machine and CoMem is listening on loopback with loopback trust enabled:

```yaml
mcp_servers:
  comem:
    url: http://127.0.0.1:1933/mcp
    tools:
      include: [health, find, read, remember]
```

When CoMem requires authentication (including Docker with loopback trust disabled), put `COMEM_TOKEN` in the Hermes profile's `.env`, then add the following under `mcp_servers.comem`:

```yaml
    headers:
      Authorization: "Bearer ${COMEM_TOKEN}"
```

Use an API key for the same CoMem account as the Memory Provider. Restart the gateway and start a new chat. For importing conversations, see the [CoMem console guide](../../docs/ingest-prompt.md). The [joint test report](../../docs/experiments/1116-hermes-comem-import/report.md) records the original MCP and streaming verification.

## Test the Webapp integration

Run `npm run typecheck`, `npm test` (including Python Query tests) and `npm run test:browser` (Chromium; override with `CHROMIUM_PATH`). For `npm run test:webapp`, use an isolated Hermes v0.23.1 gateway with the Webapp on `127.0.0.1:19120`. Install the plugin into that profile. Set the model to `stream-fixture` with `provider: custom`, `api_mode: chat_completions`, and `base_url: http://127.0.0.1:19121/v1`; use a dummy key if required. The test starts both fixture servers and writes the Query URL to the isolated profile's plugin settings. Set `OPENUI_TEST_HERMES` to the Hermes executable and `HERMES_HOME` to the test profile. Port overrides are `OPENUI_TEST_WEBAPP_PORT`, `OPENUI_FIXTURE_PORT` and `OPENUI_QUERY_FIXTURE_PORT`. Results are saved under `evidence/`. See the [Hermes and CoMem acceptance notes](../../docs/experiments/1116-hermes-comem-import/provider.md) for the live model check.
