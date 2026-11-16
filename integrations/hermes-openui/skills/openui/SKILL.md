---
name: openui
description: "Create progressive, locally interactive OpenUI answers for comparisons, calculators, checklists, data views, diagrams, maps, and other responses that are easier to use than prose alone."
---

# OpenUI Answer

Use one OpenUI answer when the user would benefit from a working page:
a comparison that changes with a control, an editable calculator or checklist,
a chart backed by rows, a visual explanation, a small game, or a place map.
Keep ordinary prose, research summaries, and short answers in Markdown.

An OpenUI page runs in the Hermes answer surface. It can hold local state and
compute with the complete catalog below. Use `@ToAssistant` only when the next
step needs a new model turn.

## Output shape

Write one short, useful paragraph of Markdown before the answer. Then emit one
directive, a blank line, and one HTML comment containing the program. Do not
append a second summary after the directive and do not put the protocol in a
Markdown code fence.

```text
A short conclusion or framing sentence.

::openui{id="ui-example-01"}

<!--openui:source id="ui-example-01"
root = Col([...])
...
openui:end-->
```

The directive ID and source-comment ID must match and stay unique within the
conversation. Keep `id` limited to letters, numbers, `.`, `_`, `:`, and `-`.

## Build the program

1. The root is `Col`. Start the source with the complete root statement so the
   page can render as it streams; forward references to statements defined
   later are intentional.
2. Put reusable page state in `$variables`. Their defaults must be literals,
   never expressions.
3. Use `@Set` for local controls that change the page. Every input must change
   visible content, affect a computed result, or sit in a `Form` whose submit
   action sends the values.
4. Use `@Each` to derive repeated rows once. Index them with `list[i]` or read
   fields with `row.field`. Reuse the rows in tables, charts, lists, and
   aggregate functions.
5. Use a conditional expression to select text or a component:
   `$view == "Evidence" ? evidenceCard : decisionCard`.
6. The page must work without another model call. Use `@ToAssistant` only for a
   genuinely new request and write its message in the user's first-person
   voice. The form values are attached automatically.
7. Finish the source comment. A root-first program is incomplete if any named
   statement used by the root is missing.

There is no user-defined function, loop statement, or `@If`. The available
functions are:

`@AddDays` `@AddMonths` `@Allocate` `@Append` `@Between` `@Bucket`
`@Capitalize` `@Change` `@Chunk` `@Clamp` `@Concat` `@Convert`
`@Cumulative` `@DaysBetween` `@Default` `@Duration` `@Find` `@Flatten`
`@Format` `@FormatDate` `@GroupBy` `@Histogram` `@Includes` `@IndexOf`
`@Join` `@Lerp` `@Lower` `@MixColor` `@MonthsBetween` `@MovingAvg`
`@Now` `@Pad` `@Payment` `@Percent` `@Pick` `@Pivot` `@Plural` `@Pow`
`@Prepend` `@Random` `@Range` `@Remove` `@RemoveAt` `@Replace`
`@Reverse` `@Shuffle` `@Slice` `@Split` `@Sqrt` `@StartOf` `@Stats`
`@Take` `@Today` `@Toggle` `@Top` `@Trim` `@Unique` `@Update` `@Upper`

`@Random`, `@Pick`, and `@Shuffle` should run inside `@Set`, so a click draws
once and the page remains stable. Use `<`, `>`, `<=`, and `>=` for numbers.
Order dates with `@DaysBetween`.

## Component catalog

**Layout**

`Col` vertical flow, `Row` horizontal flow, `Box` flexible container,
`Grid` responsive columns, `Card` a grouped panel, `Carousel`,
`Popover`, `Divider`, `Spacer`, and `Form`.

**Text**

`Title`, `Text`, `Caption`, `Label`, `Badge`, `Link`, `List`, `ListItem`,
`Markdown`, `Quote`, `Code`, and `Math`.

**Inputs**

`Button`, `IconButton`, `Pressable`, `Input`, `TextArea`, `Select`,
`SegmentedControl`, `Slider`, `Checkbox`, `RadioGroup`, `DatePicker`,
`Timer`, and `Form`.

**Media and data**

`SearchImage`, `Image`, `Icon`, `Table`, `Chart`, `Map`, `MapMarker`,
and `YouTube`.

**Play and drawing**

`Flashcard`, `Celebration`, `Svg`, `G`, `Circle`, `Ellipse`, `Rect`,
`Line`, `Path`, `Polyline`, `Polygon`, `SvgText`, and `HtmlView`.

**Hermes attribution leaves**

`CitationList`, `PhotoStrip`, and `PlaceMap`.

Spacing uses 4 px steps. Let the root `Col` and `Card` use their default
vertical rhythm. Set a gap on a `Row` or `Grid` when alignment needs it.
Use `Title("...", "xl")` for a page title and `"md"` for compact card titles.
Use `Text` at `"sm"` for supporting copy. Keep cards scannable.

## Choose the right medium

- Use `Chart` for numeric rows. `Chart("bar", rows, "label", ["value"],
  "number", null, false, 240)` is a typical bar chart. Chart types are
  `bar`, `line`, `area`, `pie`, `donut`, and `scatter`.
- Use `Table` when exact comparison matters more than shape.
- Use `Slider` and `SegmentedControl` for controls that update a visible
  explanation, calculation, chart, or follow-up.
- Use `Svg` shapes for mechanisms, geometry, assembly steps, and diagrams that
  cannot be photographed well.
- Use `HtmlView` for a canvas game or animation that needs an internal loop.
  It is sandboxed with scripts only, an opaque origin, and a restricted CSP.
  Do not use it for network APIs, credentials, forms, or host access.
- Use `Flashcard` and `Celebration` for learning and game feedback.
- Use `Map` with verified `MapMarker` coordinates for an interactive place
  view. A route is an overview and must not be described as turn-by-turn
  navigation.

## Evidence and media

Use `CitationList` for real sources. Every item needs a title, an `http` or
`https` URL, publisher, and year; an evidence note is optional:

```text
sources = CitationList([{ title: "...", url: "https://...", publisher: "...", year: "2026", note: "..." }], "Sources")
```

Never invent a citation or fetch citation metadata in the browser. If scores
are illustrative, say that once in a `Caption`.

`SearchImage` finds a real photo for a precise 2-4 word query such as
`SearchImage("Belém Tower Lisbon", 1.5)`. Name the recognizable subject. Do
not claim photo search is unavailable. The lookup requires network access and
falls back to an image placeholder when no image is returned.

Use `PhotoStrip` only for two or three exact photos supplied by the user or a
trusted tool. Every item requires `src`, `alt`, `credit`, `license`, and
`sourceUrl`; all URLs must use `https`:

```text
photos = PhotoStrip([{ src: "https://...", alt: "...", label: "...", credit: "...", license: "...", sourceUrl: "https://..." }], "Photos")
```

Use `PlaceMap` only for verified coordinates and OpenStreetMap node, way, or
relation pages. The component constructs its own embed URL and shows one
selected marker:

```text
places = PlaceMap([{ name: "...", lat: 0, lon: 0, sourceUrl: "https://www.openstreetmap.org/relation/..." }], "Places")
```

Do not invent coordinates, routes, schedules, travel times, licenses, or photo
credits.

## Read-only Query data

Use `Query("query_data", args, {rows: []})` only when the user asks for data
from the read-only endpoint configured in the Hermes plugin settings. The
argument object becomes URL query parameters on that configured endpoint:

```text
rows = Query("query_data", {window: "30d", region: ["North", "South"]}, {rows: []})
```

Use the fields actually returned by the endpoint. If the request does not
identify which fields exist, keep the answer textual or ask for the field
names. Never fill missing rows, columns, or values with invented sample data.
Label fixture rows explicitly as Demo data when the user asks for a demo.

Compute every displayed number, group, and series from the returned rows with
`@Sum`, `@Count`, `@GroupBy`, `@Bucket`, `@Top`, `@Stats`, and `@Change`.
Hermes shows a loading state while the request is active and an error with a
retry control when the configured source is unavailable.

## Interaction rules

- Bind `SegmentedControl`, `Slider`, `Select`, `RadioGroup`, `Checkbox`,
  `Input`, `TextArea`, `DatePicker`, and `Timer` to `$variables`.
- Update lists with `@Append`, `@Remove`, `@RemoveAt`, `@Update`, `@Toggle`,
  and `@Includes`.
- Use `Timer` for an intentional stopwatch or countdown. Use `Celebration`
  once its completion condition turns true.
- Use `@CopyToClipboard(@Join(rows, "\n"))` for copyable output.
- Use `@OpenUrl("https://...")` for a safe external destination. Do not use
  `javascript:`, `data:`, credentials in URLs, or unsolicited navigation.
- Controls that only send a message are dead controls. Either keep the result
  local or make the next model request explicit and task-specific.

## Representative answer

This example uses the complete live catalog, `Col` as the root, local state,
citations, a forward reference, and an explicit follow-up.

```text
Start with hybrid retrieval, then evaluate it on the target query set. Lexical
and dense methods cover different kinds of misses.

::openui{id="ui-decision-01"}

<!--openui:source id="ui-decision-01"
root = Col([header, signals, viewTabs, details, sources, follow], 4)
header = Col([Title("Choose a retrieval path", "xl"), Text("A cited recommendation for queries that mix names, codes, and semantic intent.", "md", "muted")], 2)
signals = Grid([signal1, signal2, signal3], 3, 180, 3)
signal1 = Card([Caption("Exact matches"), Title("BM25", "xl"), Text("Strong for names and identifiers.", "sm")], "soft", 3, 2)
signal2 = Card([Caption("Semantic recall"), Title("DPR", "xl"), Text("Strong for paraphrases.", "sm")], "soft", 3, 2)
signal3 = Card([Caption("Combined ranking"), Title("RRF", "xl"), Text("Merges ranked lists without score calibration.", "sm")], "soft", 3, 2)
$view = "Decision"
viewTabs = Row([Caption("View"), Spacer(), SegmentedControl($view, ["Decision", "Evidence", "Caveats"])], 3)
details = $view == "Decision" ? Card([Title("Recommendation", "md"), Text("Start with hybrid retrieval: combine BM25 and dense rankings, then evaluate on your own query set.", "sm")], "outline", 4, 2) : $view == "Evidence" ? Card([Title("Evidence", "md"), Text("BM25 supplies a lexical baseline, DPR supplies dense dual-encoder retrieval, and reciprocal rank fusion combines ranked lists without score calibration.", "sm")], "outline", 4, 2) : Card([Title("Caveats", "md"), Text("Exact identifiers favor lexical matching, while paraphrases favor dense retrieval. Fusion can add latency and does not guarantee better ranking.", "sm")], "outline", 4, 2)
sources = CitationList([{ title: "The Probabilistic Relevance Framework: BM25 and Beyond", url: "https://doi.org/10.1561/1500000019", publisher: "Foundations and Trends in Information Retrieval", year: "2009" }, { title: "Dense Passage Retrieval for Open-Domain Question Answering", url: "https://arxiv.org/abs/2004.04906", publisher: "EMNLP", year: "2020" }, { title: "Reciprocal Rank Fusion Outperforms Condorcet and Individual Rank Learning Methods", url: "https://doi.org/10.1145/1571941.1572114", publisher: "ACM SIGIR", year: "2009" }], "Sources")
follow = Button("Draft an evaluation plan", @ToAssistant("Draft an evaluation plan for hybrid retrieval using the " + $view + " view. Require citations and report recall, identifier accuracy, latency, and ranking quality."))
openui:end-->
```

When the user asks for another view or a real model action, preserve the
current page's state names and accepted form values so the next answer can
continue from what the user already selected.
