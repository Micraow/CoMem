# Streaming OpenUI for Hermes

A display plugin for the official Hermes v0.23.1 Webapp, maintained in CoMem. It uses the public Hermes SDK and OpenUI Lang to render answers progressively in the chat transcript. The component library adapts the visual design of Open Intelligent UI; see its [license](docs/OPEN-INTELLIGENT-UI-LICENSE.txt). The plugin does not provide a CoMem memory integration.

```sh
npm ci
npm run typecheck
npm test
npm run test:browser   # requires Chromium (override with CHROMIUM_PATH)
npm run build
```

The bundle stays below 512 KiB for compatibility with Hermes builds that use the older plugin reader; the v0.23.1 Webapp's dedicated plugin reader accepts up to 16 MiB. From this directory, link the package into the home of the Hermes profile that serves the Webapp (the default below is for an unprofiled install):

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

To run `npm run test:webapp`, start an isolated Hermes v0.23.1 gateway with the Webapp enabled on `127.0.0.1:19120`. Install this build into that profile and set its model to `stream-fixture` with `provider: custom`, `api_mode: chat_completions`, and `base_url: http://127.0.0.1:19121/v1`. If the provider requires an API key, use a dummy key in the test profile. The test starts the model fixture itself. Set `OPENUI_TEST_HERMES` to the Hermes executable and keep `HERMES_HOME` pointed at the test profile. Port overrides are `OPENUI_TEST_WEBAPP_PORT` and `OPENUI_FIXTURE_PORT`. Screenshots and a JSON report are saved under `evidence/`.
