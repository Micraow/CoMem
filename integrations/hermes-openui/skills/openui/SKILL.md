---
name: openui
description: "Use when a compact interactive OpenUI card helps the user adjust a value and see the result before asking a follow-up."
---

# OpenUI Card

Use one card when the answer has a small parameter the user can adjust
locally and the visible result changes with that parameter. Good cases
include changing a threshold, quantity, budget, or limit while the answer
stays readable.

Reply in Markdown when the answer is static, the result would be a document
or table, or the control would not change anything the user can inspect.
Also use Markdown when the user did not ask for interaction and an extra
control would slow the answer down.

## Generate the answer

1. Write the useful answer as ordinary Markdown first. It must make sense
   without the card.
2. Add one OpenUI card only when it adds a real local interaction.
3. Put the OpenUI source in one HTML comment. Start the source with `root`
   and refer forward to statement names defined after it, so the renderer can
   grow the card progressively.
4. Use only `Card`, `Text`, `Slider`, and `Button`.
5. Bind one `$variable` to `Slider`. Display its current value in `Text`.
6. End with one `Button` whose `@ToAssistant` message includes the current
   value. This is the explicit bridge back to the conversation.

Keep the card focused on the same answer as the prose. Use real values from
the conversation; do not invent measurements or results.

## Output protocol

The actual response contains the directive, a blank line, and one source
comment. Do not wrap the protocol in a Markdown code fence in the response.

```text
The best matches are those at or above the relevance threshold you choose.

::openui{id="ui-relevance-01"}

<!--openui:source id="ui-relevance-01"
root = Card("Prioritize results", "Adjust the cutoff locally; continue only when you want the assistant to use it.", [readout, slider, follow])
$minimum = 70
readout = Text("Show matches at or above " + $minimum + "% relevance.")
slider = Slider($minimum, 0, 100, 5, "Minimum relevance", "%")
follow = Button("Use this threshold", @ToAssistant("Use " + $minimum + "% as the relevance threshold."))
openui:end-->
```

The directive ID, opening comment ID, and closing marker must match. Keep the
ID stable for the card and unique within the conversation. The root appears
before `readout`, `slider`, and `follow` deliberately: those names become
available as the stream continues.

Use JavaScript-like string concatenation with `+` and the current `$variable`
in `@ToAssistant`. The action must describe what the assistant should do with
the visible local value. Do not emit HTML, JavaScript, network calls, or
components outside this library.
