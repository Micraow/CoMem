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

Restart the Hermes gateway and reopen the Webapp. Enable **hermes-openui** from **Capabilities → Plugins** if the browser plugin is disabled. Invoke `/hermes-openui:openui` when asking for an interactive comparison. For a build update, rescan the installed plugins and reload the Webapp. See [PROTOCOL.md](docs/PROTOCOL.md) for the model output and deterministic provider fixture.

The fixture renders before the response finishes in the official Webapp. Chromium tests verify that the OpenUI component keeps its DOM while its source grows, but Hermes v0.23.1 recreates the parent Markdown component when streaming ends. The real Webapp check for unbroken DOM identity still fails there; an end-to-end real-model smoke test is also pending.
