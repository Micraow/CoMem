# Streaming OpenUI for Hermes

An independent plugin for Hermes v0.23.1. It subscribes to the public gateway event stream and renders a progressively generated OpenUI Lang answer inside the chat transcript. There is no Hermes or CoMem core patch.

```sh
npm ci
npm run typecheck
npm test
npm run test:browser   # requires Chromium (override with CHROMIUM_PATH)
npm run build
```

The esbuild bundle must stay under the Hermes plugin loader's 512 KiB limit. For manual use, copy `desktop/plugin.js` to the `desktop-plugins/hermes-openui/plugin.js` directory under the Hermes home serving the Webapp. In the same Hermes home, copy `skills/openui` into `skills/`, then request `/openui` in a compatible chat. See [PLAN.md](PLAN.md) for scope and validation.

This first checkpoint proves the streaming path and browser interaction with a small set of components. The Open Intelligent UI visual integration and a real-model smoke test are tracked separately.
