---
name: openui
description: "Use when a compact interactive OpenUI answer makes a comparison, metric set, or local trade-off easier to understand."
---

# OpenUI Answer

Use one OpenUI answer when a visual structure makes the result easier to
scan: a small comparison, a few meaningful metrics, a focal chart, or one
value the user can adjust locally.

Reply in Markdown when the answer is mostly prose, would become a long report,
or the control would not change anything visible. Do not add an interface just
to decorate a complete answer.

## Compose the answer

1. Write the useful answer as ordinary Markdown first, including any fallback
   conclusion or caveat.
2. Add one OpenUI answer only when it clarifies the same conclusion.
3. Put the source in one HTML comment. Start with `root`, then refer forward
   to statements defined afterward so the answer can render progressively.
4. Use `Card` for the unboxed answer surface. Use `Row`, `KPI`,
   `SegmentedControl`, `BenchmarkBars`, `Insight`, `Slider`, `Caption`,
   `Text`, and `Button` as needed.
5. Bind `SegmentedControl` and `Slider` values to `$variables`. Visible output
   or the explicit `@ToAssistant` action must use every control value.
6. Label sample data honestly. When the answer contains research results, use
   measured values with provenance instead of invented benchmark scores.

Avoid nested form panels, ornamental empty shapes, and controls that only send
a message. The focal chart, metric strip, and one explicit follow-up are
enough.

## Output protocol

The actual response contains the directive, a blank line, and one source
comment. Do not wrap this protocol in a Markdown code fence in the response.

```text
Hybrid is the safer default. Semantic search wins on quality alone, while the
graph approach is faster and more efficient. These values are a local design
fixture, not published benchmark results.

::openui{id="ui-retrieval-01"}

<!--openui:source id="ui-retrieval-01"
root = Card("Retrieval strategies, compared", "A compact read on the fixture's quality-speed-efficiency trade-off.", [kpis, tabs, chart, insight, checkpoint], "RESEARCH SYNTHESIS · LOCAL DESIGN FIXTURE")
kpis = Row([kpi1, kpi2, kpi3], 4, "kpis")
kpi1 = KPI("Best balance", "Hybrid", "leads the overall fixture")
kpi2 = KPI("Quality peak", "94", "semantic, local fixture")
kpi3 = KPI("Fastest path", "90", "graph, local fixture")
$lens = "Quality"
tabs = SegmentedControl($lens, ["Quality", "Speed", "Efficiency"])
chart = BenchmarkBars($lens, "Relative performance", ["Hybrid", "Semantic", "Graph"], [88, 94, 76], [82, 61, 90], [74, 69, 86])
insight = Insight("Semantic leads on quality; Graph leads on speed and efficiency. Hybrid gives up a little of each to stay balanced.")
checkpoint = Row([threshold, follow], 3, "checkpoint")
$minimum = 75
threshold = Slider($minimum, 50, 95, 5, "Evidence floor", "%")
follow = Button("Explain this trade-off", @ToAssistant("Explain the " + $lens + " comparison above " + $minimum + "% evidence floor."))
openui:end-->
```

Keep the directive ID and source-comment ID identical and unique within the
conversation. Root-first forward references are deliberate. Finish every
started program. Use JavaScript-like `+` string concatenation in
`@ToAssistant`; interpolation such as `${...}` is not OpenUI syntax.
