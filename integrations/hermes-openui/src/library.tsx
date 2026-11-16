import {
  action,
  createLibrary,
  defineComponent,
  reactive,
  tagSchemaId,
  useFormName,
  useIsStreaming,
  useStateField,
  useTriggerAction
} from '@openuidev/react-lang'
import { useId, type CSSProperties } from 'react'
import { z } from 'zod/v4'

const node = z.any()
tagSchemaId(node, 'Node')

function numberText(value: number, unit = ''): string {
  const number = value.toLocaleString('en-US', { maximumFractionDigits: 2 })

  return /^[$€£¥₹]/.test(unit) ? `${unit}${number}` : `${number}${unit}`
}

function webUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null
  } catch {
    return null
  }
}

const Card = defineComponent({
  name: 'Card',
  description: 'Unboxed answer surface with an editorial heading and composed content.',
  props: z.object({
    title: z.string(),
    description: z.string().optional(),
    children: z.array(node),
    eyebrow: z.string().optional()
  }),
  component: ({ props, renderNode }) => (
    <section className="hermes-openui-answer" data-hermes-openui-card>
      <header className="hermes-openui-heading">
        {props.eyebrow ? <span className="hermes-openui-eyebrow">{props.eyebrow}</span> : null}
        <h3 className="hermes-openui-title">{props.title}</h3>
        {props.description ? <p className="hermes-openui-description">{props.description}</p> : null}
      </header>
      {renderNode(props.children)}
    </section>
  )
})

const Row = defineComponent({
  name: 'Row',
  description: 'Horizontal group; gap uses 4px steps.',
  props: z.object({
    children: z.array(node),
    gap: z.number().optional(),
    variant: z.enum(['kpis', 'checkpoint']).optional()
  }),
  component: ({ props, renderNode }) => (
    <div
      className={
        props.variant === 'kpis'
          ? 'hermes-openui-kpis'
          : props.variant === 'checkpoint'
            ? 'hermes-openui-checkpoint'
            : 'hermes-openui-row'
      }
      data-hermes-openui-row
      style={{ gap: typeof props.gap === 'number' ? `${Math.max(0, props.gap) * 4}px` : undefined }}
    >
      {renderNode(props.children)}
    </div>
  )
})

const Text = defineComponent({
  name: 'Text',
  description: 'A short paragraph that may depend on local state.',
  props: z.object({
    text: z.string()
  }),
  component: ({ props }) => <p className="hermes-openui-text">{props.text}</p>
})

const Caption = defineComponent({
  name: 'Caption',
  description: 'Small supporting or provenance text.',
  props: z.object({
    text: z.string()
  }),
  component: ({ props }) => <p className="hermes-openui-caption">{props.text}</p>
})

const CitationList = defineComponent({
  name: 'CitationList',
  description:
    'Compact ordered source list. Each source needs a title, http(s) URL, publisher, year, and optional evidence note.',
  props: z.object({
    items: z.array(
      z.object({
        title: z.string(),
        url: z.string(),
        publisher: z.string(),
        year: z.string(),
        note: z.string().optional()
      })
    ),
    title: z.string().optional()
  }),
  component: ({ props }) => {
    const items = props.items.filter(item => item.title.trim() && item.url.trim())

    return (
      <section
        aria-label={props.title ?? 'Sources'}
        className="hermes-openui-citations"
        data-hermes-openui-citations
      >
        <h4 className="hermes-openui-citations-title">{props.title ?? 'Sources'}</h4>
        <ol className="hermes-openui-citation-list">
          {items.map((item, index) => {
            const href = webUrl(item.url)
            const attribution = [item.publisher, item.year].filter(Boolean).join(' · ')

            return (
              <li
                className="hermes-openui-citation"
                data-hermes-openui-citation
                data-safe-url={href ? 'true' : 'false'}
                key={`${item.url}-${index}`}
              >
                <div className="hermes-openui-citation-body">
                  {href ? (
                    <a
                      className="hermes-openui-citation-link"
                      href={href}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      {item.title}
                    </a>
                  ) : (
                    <span className="hermes-openui-citation-link">{item.title}</span>
                  )}
                  <span className="hermes-openui-citation-meta">{attribution}</span>
                  {item.note ? (
                    <span className="hermes-openui-citation-note">{item.note}</span>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ol>
      </section>
    )
  }
})

const Kpi = defineComponent({
  name: 'KPI',
  description: 'Compact label, prominent value, and optional supporting note.',
  props: z.object({
    label: z.string(),
    value: z.string(),
    note: z.string().optional()
  }),
  component: ({ props }) => (
    <div className="hermes-openui-kpi" data-hermes-openui-kpi>
      <span className="hermes-openui-kpi-label">{props.label}</span>
      <strong className="hermes-openui-kpi-value">{props.value}</strong>
      {props.note ? <span className="hermes-openui-kpi-note">{props.note}</span> : null}
    </div>
  )
})

const Insight = defineComponent({
  name: 'Insight',
  description: 'One emphasized takeaway below the main result.',
  props: z.object({
    text: z.string()
  }),
  component: ({ props }) => (
    <div className="hermes-openui-insight" data-hermes-openui-insight>
      <p className="hermes-openui-text">{props.text}</p>
    </div>
  )
})

const SegmentedControl = defineComponent({
  name: 'SegmentedControl',
  description: 'Two to four short local choices in a pill control.',
  props: z.object({
    value: reactive(z.string()),
    options: z.array(z.string())
  }),
  component: ({ props, statementId }) => {
    const streaming = useIsStreaming()
    const field = useStateField<string>(statementId ?? 'segment', props.value as unknown as string)
    const options = props.options.filter(Boolean)
    const selected = options.includes(String(field.value)) ? String(field.value) : options[0] ?? ''

    return (
      <div
        aria-label="Local view"
        className="hermes-openui-segmented"
        data-hermes-openui-segmented
        role="radiogroup"
      >
        {options.map(option => (
          <button
            aria-checked={option === selected}
            className={option === selected ? 'is-selected' : undefined}
            disabled={streaming}
            key={option}
            onClick={() => field.setValue(option)}
            role="radio"
            type="button"
          >
            {option}
          </button>
        ))}
      </div>
    )
  }
})

const BenchmarkBars = defineComponent({
  name: 'BenchmarkBars',
  description:
    'Focal horizontal comparison. The reactive lens selects one of quality, speed, or efficiency arrays.',
  props: z.object({
    lens: reactive(z.string()),
    title: z.string(),
    labels: z.array(z.string()),
    quality: z.array(z.number()),
    speed: z.array(z.number()),
    efficiency: z.array(z.number()),
    floor: reactive(z.number()).optional(),
    unit: z.string().optional()
  }),
  component: ({ props, statementId }) => {
    const field = useStateField<string>(statementId ?? 'benchmark', props.lens as unknown as string)
    const lens = ['Quality', 'Speed', 'Efficiency'].includes(String(field.value))
      ? String(field.value)
      : 'Quality'
    const values =
      lens === 'Speed' ? props.speed : lens === 'Efficiency' ? props.efficiency : props.quality
    const floor =
      typeof props.floor === 'number' && Number.isFinite(props.floor)
        ? Math.min(100, Math.max(0, props.floor))
        : 0
    const rows = props.labels.map((label, index) => ({
      label,
      value: Math.min(100, Math.max(0, values[index] ?? 0)),
      below: floor > 0 && (values[index] ?? 0) < floor
    }))
    const belowCount = rows.filter(row => row.below).length
    const leader = rows.reduce(
      (best, row, index) => (row.value > rows[best].value ? index : best),
      0
    )
    const formatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })

    return (
      <figure
        aria-label={`${props.title}, ${lens}`}
        className="hermes-openui-benchmark"
        data-hermes-openui-chart
        data-hermes-openui-lens={lens}
      >
        <header className="hermes-openui-benchmark-head">
          <h4 className="hermes-openui-benchmark-title">{props.title}</h4>
          <span className="hermes-openui-benchmark-meta">
            <strong>{lens}</strong> view ·{' '}
            {floor > 0
              ? `${belowCount} ${belowCount === 1 ? 'bar' : 'bars'} below ${floor}%`
              : `${rows[leader]?.label ?? 'No result'} leads`}
          </span>
        </header>
        <div className="hermes-openui-bars">
          {rows.map((row, index) => (
            <div
              className={`hermes-openui-bar-row is-${Math.min(3, index + 1)}${row.below ? ' is-below' : ''}`}
              data-hermes-openui-bar={row.label}
              data-hermes-openui-below={row.below ? 'true' : 'false'}
              key={row.label}
            >
              <span className="hermes-openui-bar-rank">{String(index + 1).padStart(2, '0')}</span>
              <span className="hermes-openui-bar-label">{row.label}</span>
              <span className="hermes-openui-bar-track" aria-hidden>
                <span
                  className="hermes-openui-bar-fill"
                  style={{ width: `${row.value}%` } as CSSProperties}
                />
              </span>
              <span className="hermes-openui-bar-value">
                {formatter.format(row.value)}
                {props.unit ?? ''}
              </span>
            </div>
          ))}
        </div>
      </figure>
    )
  }
})

const Slider = defineComponent({
  name: 'Slider',
  description: 'A local numeric control. Pass a reactive $variable and display it elsewhere.',
  props: z.object({
    value: reactive(z.number()),
    min: z.number(),
    max: z.number(),
    step: z.number().optional(),
    label: z.string(),
    unit: z.string().optional()
  }),
  component: ({ props, statementId }) => {
    const streaming = useIsStreaming()
    const field = useStateField<number>(statementId ?? props.label, props.value as unknown as number)
    const id = useId()
    const min = Math.min(props.min, props.max)
    const max = Math.max(props.min, props.max)
    const step = props.step && props.step > 0 ? props.step : 1
    const numeric = typeof field.value === 'number' && Number.isFinite(field.value) ? field.value : min
    const value = Math.min(max, Math.max(min, numeric))
    const readout = numberText(value, props.unit ?? '')

    return (
      <div className="hermes-openui-slider">
        <div className="hermes-openui-slider-head">
          <label htmlFor={id}>{props.label}</label>
          <output data-hermes-openui-output htmlFor={id}>
            {readout}
          </output>
        </div>
        <input
          aria-label={props.label}
          aria-valuetext={readout}
          data-hermes-openui-range
          disabled={streaming}
          id={id}
          max={max}
          min={min}
          onChange={event => field.setValue(Number(event.currentTarget.value))}
          step={step}
          type="range"
          value={value}
        />
      </div>
    )
  }
})

const Button = defineComponent({
  name: 'Button',
  description: 'One explicit follow-up action in the answer.',
  props: z.object({
    label: z.string(),
    action: action()
  }),
  component: ({ props }) => {
    const streaming = useIsStreaming()
    const triggerAction = useTriggerAction()
    const formName = useFormName()

    return (
      <button
        className="hermes-openui-action"
        data-hermes-openui-follow-up
        disabled={streaming}
        onClick={() => void triggerAction(props.label, formName, props.action)}
        type="button"
      >
        {props.label}
      </button>
    )
  }
})

export const openUILibrary = createLibrary({
  id: 'hermes-openui-intelligent-answer',
  root: 'Card',
  components: [
    Card,
    Row,
    Text,
    Caption,
    CitationList,
    Kpi,
    Insight,
    SegmentedControl,
    BenchmarkBars,
    Slider,
    Button
  ]
})

export const DESIGN_OPENUI_PROGRAM = `root = Card("Choose a retrieval strategy", "Hybrid is the safer default for mixed exact-match and semantic queries.", [kpis, tabs, chart, insight, checkpoint, note])
kpis = Row([kpi1, kpi2, kpi3], 4, "kpis")
kpi1 = KPI("Balanced", "Hybrid", "no axis in last place")
kpi2 = KPI("Quality", "94", "semantic")
kpi3 = KPI("Speed", "90", "graph")
$lens = "Quality"
$minimum = 75
tabs = SegmentedControl($lens, ["Quality", "Speed", "Efficiency"])
chart = BenchmarkBars($lens, "Illustrative scores", ["Hybrid", "Semantic", "Graph"], [88, 94, 76], [82, 61, 90], [74, 69, 86], $minimum)
insight = Insight($lens == "Quality" ? "Choose semantic when nuanced recall matters most; choose hybrid when exact identifiers must stay covered." : $lens == "Speed" ? "Choose graph when latency dominates; choose hybrid when query types vary." : "Choose graph for throughput; choose hybrid when corpus behavior is uneven.")
threshold = Slider($minimum, 50, 95, 5, "Evidence floor", "%")
checkpoint = Row([threshold, follow], 3, "checkpoint")
note = Caption("Illustrative 0-100 scores, not measured benchmarks.")
follow = Button("Explain this trade-off", @ToAssistant("Explain the " + $lens + " comparison above " + $minimum + "% evidence floor."))`

export const DECISION_BRIEF_OPENUI_PROGRAM = `root = Card("Choose a retrieval path", "A cited recommendation for queries that mix names, codes, and semantic intent.", [signals, viewTabs, details, sources, follow])
signals = Row([signal1, signal2, signal3], 4, "kpis")
signal1 = KPI("Exact matches", "BM25")
signal2 = KPI("Semantic recall", "DPR")
signal3 = KPI("Combined ranking", "RRF")
$view = "Decision"
viewTabs = SegmentedControl($view, ["Decision", "Evidence", "Caveats"])
details = $view == "Decision" ? Insight("Start with hybrid retrieval: combine BM25 and dense rankings, then evaluate on your own query set.") : $view == "Evidence" ? Insight("BM25 supplies a lexical baseline, DPR supplies dense dual-encoder retrieval, and reciprocal rank fusion combines ranked lists without score calibration.") : Insight("Exact identifiers favor lexical matching, while paraphrases favor dense retrieval. Fusion can add latency and does not guarantee better ranking.")
sources = CitationList([{ title: "The Probabilistic Relevance Framework: BM25 and Beyond", url: "https://doi.org/10.1561/1500000019", publisher: "Foundations and Trends in Information Retrieval", year: "2009" }, { title: "Dense Passage Retrieval for Open-Domain Question Answering", url: "https://arxiv.org/abs/2004.04906", publisher: "EMNLP", year: "2020" }, { title: "Reciprocal Rank Fusion Outperforms Condorcet and Individual Rank Learning Methods", url: "https://doi.org/10.1145/1571941.1572114", publisher: "ACM SIGIR", year: "2009" }], "Sources")
follow = Button("Draft an evaluation plan", @ToAssistant("Draft an evaluation plan for hybrid retrieval using the " + $view + " view. Require citations and report recall, identifier accuracy, latency, and ranking quality."))`

export const OPENUI_PROMPT = openUILibrary.prompt({
  preamble:
    'When an answer benefits from one interactive visual explanation, compose a compact OpenUI answer using the local design system.',
  additionalRules: [
    'Use Card as the root. Start with root so forward references can render progressively.',
    'Use Row, KPI, SegmentedControl, BenchmarkBars, CitationList, Insight, Slider, Caption, Text, and Button as needed.',
    'Keep the surface unboxed: do not invent nested form panels or decorative placeholder shapes.',
    'Bind SegmentedControl and Slider values to $variables. Every control must change visible content or an explicit follow-up.',
    'Give Card a specific title and one useful description. Do not use fixture, demo, design, or component vocabulary in user-visible labels.',
    'A chart already shows its values. Use at most one Insight for the decision implication and do not repeat every number in Markdown, Text, or Caption.',
    'Do not explain how controls work in prose. Make each control change visible content and end with one task-specific follow-up.',
    'If scores are illustrative, disclose that once in a final Caption. Cite research with real publisher, year, and http(s) URLs instead of invented sources.',
    'Do not invent photographs or map geometry, and do not fetch citation metadata in the browser.',
    'Keep text outside the directive to one concise takeaway before it. Do not append a second summary after the directive.'
  ],
  examples: [DECISION_BRIEF_OPENUI_PROGRAM, DESIGN_OPENUI_PROGRAM]
})

export const SAMPLE_OPENUI_PROGRAM = `$minimum = 70
readout = Text("Showing results with at least " + $minimum + "% relevance.")
slider = Slider($minimum, 0, 100, 5, "Minimum relevance", "%")
follow = Button("Explain these results", @ToAssistant("Explain the current results at this relevance threshold."))
root = Card("Filter results", "Move the threshold to narrow the set locally.", [readout, slider, follow])`
