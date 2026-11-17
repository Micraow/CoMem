# OpenUI streaming protocol and local fixture

## Source envelope

The assistant emits one directive and one HTML comment:

```text
::openui{id="ui-abc123"}

<!--openui:source id="ui-abc123"
root = Col([header, body], 4)
header = Col([Title("Example", "xl"), Text("Description", "md", "muted")], 2)
body = Card([Text("Details")], "outline", 4, 2)
openui:end-->
```

The opening marker ends after `id="…"` with a line feed. The closing marker is
`\nopenui:end-->`. The source is everything between those two byte sequences.

While the response is live, a nonempty source prefix is rendered with
`sourceState: "streaming"` and `streaming: true`. A suffix that could be part of
`\nopenui:end-->` is withheld so `openui:e` or `openui:end-` never appears as
OpenUI source. On the final delta the card switches to `complete`. A terminal
`message.complete` caches the card only when both the end marker and
`payload.status === "complete"` are present.

## Read-only Query bridge

The OpenUI runtime performs `Query("query_data", args, {rows: []})` through
Hermes' authenticated plugin REST namespace. This route is separate from
model-callable tools: the model receives no rows, source URL, or upstream
credential.

`GET /api/plugins/hermes-openui/capabilities` reports whether the profile has a
valid configured endpoint without exposing its URL:

```json
{"query_data": {"configured": true}}
```

`POST /api/plugins/hermes-openui/query` accepts:

```json
{"arguments": {"window": "30d", "region": ["North", "South"]}}
```

The backend reads `plugins.entries.hermes-openui.settings.query_url` from the
same Hermes profile and sends one `GET` request. Model arguments are appended
as query parameters. Argument names must start with a letter, contain only
letters, digits, and underscores, and have scalar or scalar-array values.
Strings are capped at 2,000 characters, arrays at 50 values, and the argument
object at 32 keys.

The optional bearer credential comes from `HERMES_OPENUI_QUERY_TOKEN` in the
profile's `.env`. The plugin settings page exposes it as a secret field and
stores it through Hermes' credential route. The credential is never returned
to the browser or included in the request body.

The configured URL must be credential-free HTTPS. Plain HTTP is allowed only
when the hostname is loopback. Fragments are rejected. The request timeout is
10 seconds and redirects are refused.

The upstream service must return `{"rows": [{"...": "..."}]}`. Every row must
be a JSON object. The bridge rejects responses over 1 MB or 5,000 rows and
returns the validated object unchanged. Missing configuration, network
failure, redirect, non-2xx status, invalid JSON, invalid row shape, and size
limits produce an HTTP error. The OpenUI renderer displays a visible Query
error with a retry control.

Normal answers must not replace an unavailable configured source with fixture
rows. Demo fixtures are permitted only when the rendered card explicitly
labels them as demo data.

## Fixture

`tests/model-fixture.mjs` is a loopback-only OpenAI-compatible model server. It
performs no outbound network calls. Run it directly with:

```bash
node tests/model-fixture.mjs
```

The default OpenAI base URL is `http://127.0.0.1:19121/v1`.

| Environment variable | Default | Meaning |
|---|---:|---|
| `OPENUI_FIXTURE_HOST` | `127.0.0.1` | Bind host |
| `OPENUI_FIXTURE_PORT` | `19121` | Fixture port |
| `OPENUI_FIXTURE_CHUNK_DELAY_MS` | `90` | Delay after ordinary chunks |
| `OPENUI_FIXTURE_HALFWAY_PAUSE_MS` | `5000` | Pause after the final source line and before END |
| `OPENUI_FIXTURE_END_DELAY_MS` | `750` | Pause after END and before normal completion |

The module can also be embedded in the browser test:

```js
import {
  PRIMARY_PROMPT,
  SECOND_SESSION_PROMPT,
  startModelFixture
} from './model-fixture.mjs'

const fixture = await startModelFixture({
  primaryProgram: referencePrimaryProgram,
  secondaryProgram: referenceSecondProgram
})

// Point Hermes at fixture.url.
await fixture.close()
```

`createFixtureResponse({ id, program })` is the pure response generator. It
breaks every source line into a separate chunk, marks the final source line as
`partialSource`, then sends the closing marker as a later chunk. This makes an
early card mount observable before the model-completion phase.

The exported prompts are:

- `PRIMARY_PROMPT`: starts the primary interactive card.
- `SECOND_SESSION_PROMPT`: starts the secondary program in a separate session.
- `QUERY_PROMPT`: starts a `Query("query_data", ...)` card.
- `FOLLOW_UP_TEXT`: the fallback card's follow-up action text.

`tests/webapp.mjs` also starts a loopback read-only query source on port 19124
and writes its URL to the isolated Hermes profile before loading the Webapp.
The test verifies that the browser-side Query uses `ctx.rest`, reaches that
source with the requested arguments, and renders the returned rows. Override
the port with `OPENUI_QUERY_FIXTURE_PORT`.

## Test state

`GET /fixture-state` returns the current phase, counters, and per-request
sessions. Probes such as `GET /v1/models`, `GET /health`, and reads of
`/fixture-state` never change counters.

Counters increment only for valid completion requests:

- `requests`: all accepted completion POST requests.
- `streams`: streamed completion requests.
- `cardStarts`: primary, secondary, or Query card responses.
- `partialSourceSent`: responses that sent all source lines without END.
- `sourceEnded`: responses that sent the END marker.
- `completed`: primary, secondary, or Query card streams that ended normally.
- `interrupted`: primary, secondary, or Query card streams closed before normal
  completion, which is the normal Stop path.
- `responsesCompleted`: all completion responses that ended normally, including
  auxiliary non-card calls.
- `responsesInterrupted`: all completion responses interrupted before normal
  completion.
- `followups`: follow-up prompts recognized from conversation history.
- `secondSessionStarts`: secondary-program starts.
- `queryStarts`: configured-source Query-card starts.

Top-level `starts`, `completed`, and `followups` aliases remain available for
older assertions. Per-session `card`, `kind`, `phase`, `partialSource`,
`sourceEnded`, `complete`, and `interrupted` let a test prove that a card
mounted before the terminal response completed.

Use `POST /fixture-state/reset` only when a test needs a clean counter window.
Normal tests should compare before/after snapshots so model discovery and
provider probes remain harmless.
