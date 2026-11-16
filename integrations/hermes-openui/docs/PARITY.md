# Open Intelligent UI parity

This plugin carries the full Open Intelligent UI language into the stock Hermes
answer surface and adapts the browser-only demo integrations to contracts that
Hermes can serve.

Catalog baseline:
`thesysdev/open-intelligent-ui@8ecdd17297d1f15cecfbc8750817dda5a576c401`
(MIT). The original license is in
[`OPEN-INTELLIGENT-UI-LICENSE.txt`](OPEN-INTELLIGENT-UI-LICENSE.txt).

## Catalog

| Surface | Native |
|---|---|
| Root | `Col` |
| Components | 55 catalog components |
| Functions | 59 `@functions` |
| Actions | `@CopyToClipboard` |
| Progressive output | Root-first statements render while source streams |
| State | `$variables`, `@Set`, form values, and persisted local state |
| Repetition/computation | `@Each`, indexing, conditionals, lists, tables, charts, and all catalog functions |
| Visual coverage | Layout, text, controls, media, tables, six chart types, maps, SVG, sandboxed HTML, markdown, math, code, flashcards, carousels, popovers, and clipboard actions |
| Hermes leaves | `CitationList`, `PhotoStrip`, and `PlaceMap` add source and attribution checks |

The live schema test asserts all 55 catalog components, all 59 functions, the
single custom action, and the three Hermes leaves. It also parses every
published prompt example, the three Hermes fixtures, and the skill sample.

## Hermes adaptations

| Area | Behavior |
|---|---|
| Photo search | `SearchImage` calls the public English Wikipedia MediaWiki API directly and caches successful results. |
| Maps | The catalog `Map` uses MapLibre and loads `maplibre-gl-worker.mjs` beside the bundled `plugin.js`. |
| Street routes | `Map` requests driving geometry from the public OSRM demo service. The UI labels it as an overview. |
| Clipboard | `@CopyToClipboard` uses the Clipboard API with a focused textarea fallback. |
| External URLs | `@OpenUrl` opens only credential-free `http` and `https` URLs in a new tab. |
| Read-only queries | `Query("query_data", ...)` uses Hermes' authenticated, profile-scoped plugin REST bridge. The profile owner configures one GET endpoint and optional bearer credential; the browser can pass scalar or scalar-array query parameters but cannot choose the host or method. |
| Attribution media | `PhotoStrip` requires exact HTTPS media and source URLs plus credit and license. `PlaceMap` accepts only verified coordinates and OpenStreetMap entity URLs. |

The generated `plugin.js` is about 3.0 MB and the worker is about 0.50 MB in
the current build. KaTeX's WOFF2 fonts are embedded in the bundle so the stock
Webapp CSP does not require a CDN font exception. Stock Hermes v0.23.1 accepts
this bundle through its dedicated plugin reader. The older 512 KiB preview
read target is not the v0.23.1 plugin reader's limit.

## Contract limits

- Hermes does not serve the catalog project's application demo endpoints.
  Components that depended on those routes use the adaptations above.
- `SearchImage`, MapLibre basemaps, and OSRM routes require outbound network
  access. Failures render a local placeholder or direct-route map fallback.
- The MapLibre worker is generated and ignored by source control. Any
  deployment must run `npm run build` and keep
  `desktop/maplibre-gl-worker.mjs` beside `desktop/plugin.js`.
- Stock Hermes has no output-correction hook that can repair malformed OpenUI
  after generation. The stream store validates the source envelope and the
  renderer reports a user-facing unavailable state.
- Private model-callable tools use `ctx.register_tool` and return through the
  model context. The OpenUI browser Query bridge deliberately does not use that
  path: it calls the authenticated `/api/plugins/hermes-openui/query` route,
  so private rows never enter the model transcript.
- `query_data` cannot choose a host, HTTP method, or credential. Arguments
  become GET query parameters for the profile owner's configured URL. Missing
  configuration and upstream failures render visibly; no fixture rows are
  substituted.
- The configured source must return `{"rows": [...]}` with at most 1 MB and
  5,000 object rows. Redirects are refused and the request has a 10 second
  timeout. HTTPS is required except for loopback development.
- The runtime does not rewrite the model's program. The model must follow the
  registered `hermes-openui:openui` skill, including root `Col`, forward
  references, local state, and safe media rules.
- Stock Hermes discovers the skill, but generic model routing does not
  guarantee automatic invocation. Invoke `/hermes-openui:openui` before the
  request when the answer must use OpenUI.
- `HtmlView` runs with `sandbox="allow-scripts"`, an opaque origin, no host
  storage, no forms, no popups, and a CSP that blocks arbitrary network
  requests.
- Browser verification currently targets Chromium through the stock Hermes
  v0.23.1 setup. Firefox and WebKit are not covered.

## Progressive rendering and continuity

The source protocol is deliberately root-first:

```text
root = Col([header, details], 4)
header = Title("...")
details = ...
```

The renderer mounts the root before the referenced statements arrive, then
adds completed statements as the source grows. The terminator
`openui:end-->` marks a complete program. The stream store creates a new card
snapshot when source changes, so local component state can continue only when
the host keeps the same directive mount and React identity.

The stock Webapp does replace transcript DOM while a message settles. The
plugin cannot control that host behavior. A completed program therefore
restores state from the per-session local snapshot; controls that were changed
before finalization can still reset when the host remounts the directive.

## Acceptance boundary

The local browser suite verifies catalog parsing, root-first updates, charts,
segmented controls, sliders, follow-up actions, persisted local state,
clipboard, URL filtering, the HTML sandbox, Query loading/failure/retry,
Wikipedia image search, and a real MapLibre worker request with marker
selection. The Python suite verifies the configured URL, GET-only bridge,
server-side bearer token, redirect refusal, row validation, and capabilities.

The stock-host test verifies Hermes v0.23.1 plugin loading and the transcript
directive bridge, including a real `Query` card whose `ctx.rest` call reaches a
configured loopback read-only source. Provider/model acceptance is separate
from renderer parity: a passing provider recall run does not prove that a model
emitted a valid OpenUI program, and a valid program does not prove live model
quality.
