# OpenUI streaming protocol and local fixture

## Source envelope

The assistant emits one directive and one HTML comment:

```text
::openui{id="ui-abc123"}

<!--openui:source id="ui-abc123"
root = Card("Example", "Description", [body])
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
- `FOLLOW_UP_TEXT`: the fallback card's follow-up action text.

## Test state

`GET /fixture-state` returns the current phase, counters, and per-request
sessions. Probes such as `GET /v1/models`, `GET /health`, and reads of
`/fixture-state` never change counters.

Counters increment only for valid completion requests:

- `requests`: all accepted completion POST requests.
- `streams`: streamed completion requests.
- `cardStarts`: primary or secondary card responses.
- `partialSourceSent`: responses that sent all source lines without END.
- `sourceEnded`: responses that sent the END marker.
- `completed`: primary or secondary card streams that ended normally.
- `interrupted`: primary or secondary card streams closed before normal
  completion, which is the normal Stop path.
- `responsesCompleted`: all completion responses that ended normally, including
  auxiliary non-card calls.
- `responsesInterrupted`: all completion responses interrupted before normal
  completion.
- `followups`: follow-up prompts recognized from conversation history.
- `secondSessionStarts`: secondary-program starts.

Top-level `starts`, `completed`, and `followups` aliases remain available for
older assertions. Per-session `card`, `kind`, `phase`, `partialSource`,
`sourceEnded`, `complete`, and `interrupted` let a test prove that a card
mounted before the terminal response completed.

Use `POST /fixture-state/reset` only when a test needs a clean counter window.
Normal tests should compare before/after snapshots so model discovery and
provider probes remain harmless.
