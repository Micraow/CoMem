# Streaming OpenUI for Hermes

A display plugin for the official Hermes v0.23.1 Webapp, maintained in CoMem. It uses the public Hermes SDK and OpenUI Lang to render answers progressively in the chat transcript. The component library adapts the visual design of Open Intelligent UI; see its [license](docs/OPEN-INTELLIGENT-UI-LICENSE.txt). The plugin does not provide a CoMem memory integration.

```sh
npm ci
npm run typecheck
npm test
npm run test:browser   # requires Chromium (override with CHROMIUM_PATH)
npm run build
```

The bundle must fit the Hermes plugin loader's 512 KiB limit. From this directory, link the package into the home of the Hermes profile that serves the Webapp (the default below is for an unprofiled install):

```sh
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
mkdir -p "$HERMES_HOME/plugins"
ln -s "$PWD" "$HERMES_HOME/plugins/hermes-openui"
hermes plugins doctor --ci "$PWD"
hermes plugins enable hermes-openui
```

Restart the Hermes gateway and reopen the Webapp. Enable **hermes-openui** from **Capabilities → Plugins**; Hermes leaves the browser half of unified packages off by default. In an existing chat, invoke `/hermes-openui:openui` followed by your request, for example: `Compare hybrid, semantic, and graph retrieval using clearly labeled illustrative scores, and let me switch the metric.` For a build update, rescan the installed plugins and reload the Webapp. See [PROTOCOL.md](docs/PROTOCOL.md) for the model output and deterministic provider fixture.

No Hermes patch is needed. The card appears as its source arrives; controls become available after the answer finishes. Hermes v0.23.1 can replace the transcript DOM at completion. The browser test measures whether the card stays visibly present and separately records whether Hermes reused its node.

The bundled examples cover a comparison with a local threshold and a cited brief with views that change locally. Source links are supplied by the model; the plugin checks the URL scheme but does not verify the model's claims. Maps, image search, and the full upstream component catalog are outside this build.

To run `npm run test:webapp`, start an isolated Hermes v0.23.1 gateway with the Webapp enabled on `127.0.0.1:19120`. Install this build into that profile and set its model to `stream-fixture` with `provider: custom`, `api_mode: chat_completions`, and `base_url: http://127.0.0.1:19121/v1`. If the provider requires an API key, use a dummy key in the test profile. The test starts the model fixture itself. Set `OPENUI_TEST_HERMES` to the Hermes executable and keep `HERMES_HOME` pointed at the test profile. Port overrides are `OPENUI_TEST_WEBAPP_PORT` and `OPENUI_FIXTURE_PORT`. Screenshots and a JSON report are saved under `evidence/`.
