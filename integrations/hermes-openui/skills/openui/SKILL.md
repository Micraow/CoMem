---
name: openui
description: "Use when a compact interactive OpenUI answer makes a cited decision, comparison, photo set, or local trade-off easier to understand."
---

# OpenUI Answer

Use one OpenUI answer when a visual structure makes the result easier to
scan: a sourced decision brief, a small comparison, a few meaningful metrics,
a focal chart, or one value the user can adjust locally.

Reply in Markdown when the answer is mostly prose, would become a long report,
or the control would not change anything visible. Do not add an interface just
to decorate a complete answer.

## Compose the answer

1. Write one or two sentences of useful Markdown before the directive. Do not
   append another summary after it.
2. Add one OpenUI answer only when it adds structure or interaction.
3. Put the source in one HTML comment. Start with `root`, then refer forward
   to statements defined afterward so the answer can render progressively.
4. Use `Card` for the unboxed answer surface. Use `Row`, `KPI`,
   `SegmentedControl`, `CitationList`, `PhotoStrip`, `BenchmarkBars`,
   `Insight`, `Slider`, `Caption`, `Text`, and `Button` as needed.
5. Bind `SegmentedControl` and `Slider` values to `$variables`. Visible output
   or the explicit `@ToAssistant` action must use every control value.
6. Give `Card` a specific title and at most one useful description. Do not use
   fixture, demo, design, or component vocabulary in user-visible labels.
7. A chart already shows its values. Use at most one `Insight` for the decision
   implication and do not repeat every number in Markdown or below the chart.
8. Do not explain control mechanics in prose. Each control must change visible
   content and end in one task-specific follow-up.
9. If scores are illustrative, disclose that once in a final `Caption`. Cite
   research with real titles, publishers, years, and `http(s)` URLs. Never
   invent a source or fetch citation metadata in the browser.
10. Use `PhotoStrip` only when the user or a trusted tool supplied two or three
    exact photos. Every photo needs an `https` image URL, alt text, credit,
    license, and `https` source-page URL:
    `PhotoStrip([{ src, alt, label, credit, license, sourceUrl }], "Title")`.
    Do not search for photos in the browser or draw substitute imagery.

Avoid nested form panels, ornamental empty shapes, and controls that only send
a message. A compact source list, one semantic local view, and one explicit
follow-up are enough.

## Output protocol

The actual response contains the directive, a blank line, and one source
comment. Do not wrap this protocol in a Markdown code fence in the response.

```text
Start with hybrid retrieval, then evaluate it on the target query set. Lexical
and dense methods cover different kinds of misses.

::openui{id="ui-decision-01"}

<!--openui:source id="ui-decision-01"
root = Card("Choose a retrieval path", "A cited recommendation for queries that mix names, codes, and semantic intent.", [signals, viewTabs, details, sources, follow])
signals = Row([signal1, signal2, signal3], 4, "kpis")
signal1 = KPI("Exact matches", "BM25")
signal2 = KPI("Semantic recall", "DPR")
signal3 = KPI("Combined ranking", "RRF")
$view = "Decision"
viewTabs = SegmentedControl($view, ["Decision", "Evidence", "Caveats"])
details = $view == "Decision" ? Insight("Start with hybrid retrieval: combine BM25 and dense rankings, then evaluate on your own query set.") : $view == "Evidence" ? Insight("BM25 supplies a lexical baseline, DPR supplies dense dual-encoder retrieval, and reciprocal rank fusion combines ranked lists without score calibration.") : Insight("Exact identifiers favor lexical matching, while paraphrases favor dense retrieval. Fusion can add latency and does not guarantee better ranking.")
sources = CitationList([{ title: "The Probabilistic Relevance Framework: BM25 and Beyond", url: "https://doi.org/10.1561/1500000019", publisher: "Foundations and Trends in Information Retrieval", year: "2009" }, { title: "Dense Passage Retrieval for Open-Domain Question Answering", url: "https://arxiv.org/abs/2004.04906", publisher: "EMNLP", year: "2020" }, { title: "Reciprocal Rank Fusion Outperforms Condorcet and Individual Rank Learning Methods", url: "https://doi.org/10.1145/1571941.1572114", publisher: "ACM SIGIR", year: "2009" }], "Sources")
follow = Button("Draft an evaluation plan", @ToAssistant("Draft an evaluation plan for hybrid retrieval using the " + $view + " view. Require citations and report recall, identifier accuracy, latency, and ranking quality."))
openui:end-->
```

Keep the directive ID and source-comment ID identical and unique within the
conversation. Root-first forward references are deliberate. Finish every
started program. Use JavaScript-like `+` string concatenation in
`@ToAssistant`; interpolation such as `${...}` is not OpenUI syntax.
