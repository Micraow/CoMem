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
        aria-label="Comparison view"
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
    unit: z.string().optional()
  }),
  component: ({ props, statementId }) => {
    const field = useStateField<string>(statementId ?? 'benchmark', props.lens as unknown as string)
    const lens = ['Quality', 'Speed', 'Efficiency'].includes(String(field.value))
      ? String(field.value)
      : 'Quality'
    const values =
      lens === 'Speed' ? props.speed : lens === 'Efficiency' ? props.efficiency : props.quality
    const rows = props.labels.map((label, index) => ({
      label,
      value: Math.min(100, Math.max(0, values[index] ?? 0))
    }))
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
            <strong>{lens}</strong> view · {rows[leader]?.label ?? 'No result'} leads
          </span>
        </header>
        <div className="hermes-openui-bars">
          {rows.map((row, index) => (
            <div
              className={`hermes-openui-bar-row is-${Math.min(3, index + 1)}`}
              data-hermes-openui-bar={row.label}
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
    Kpi,
    Insight,
    SegmentedControl,
    BenchmarkBars,
    Slider,
    Button
  ]
})

export const DESIGN_OPENUI_PROGRAM = `root = Card("Retrieval strategies, compared", "A compact read on the fixture's quality-speed-efficiency trade-off.", [kpis, tabs, chart, insight, checkpoint], "RESEARCH SYNTHESIS · LOCAL DESIGN FIXTURE")
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
follow = Button("Explain this trade-off", @ToAssistant("Explain the " + $lens + " comparison above " + $minimum + "% evidence floor."))`

export const OPENUI_PROMPT = openUILibrary.prompt({
  preamble:
    'When an answer benefits from one interactive visual explanation, compose a compact OpenUI answer using the local design system.',
  additionalRules: [
    'Use Card as the root. Start with root so forward references can render progressively.',
    'Use Row, KPI, SegmentedControl, BenchmarkBars, Insight, Slider, Caption, Text, and Button as needed.',
    'Keep the surface unboxed: do not invent nested form panels or decorative placeholder shapes.',
    'Bind SegmentedControl and Slider values to $variables. Every control must change visible content or an explicit follow-up.',
    'Label sample or fixture data honestly. Use real measured values and provenance when the answer contains research results.',
    'End with exactly one Button whose @ToAssistant message includes the current local values.'
  ],
  examples: [DESIGN_OPENUI_PROGRAM]
})

export const SAMPLE_OPENUI_PROGRAM = `$minimum = 70
readout = Text("Showing results with at least " + $minimum + "% relevance.")
slider = Slider($minimum, 0, 100, 5, "Minimum relevance", "%")
follow = Button("Explain these results", @ToAssistant("Explain the current results at this relevance threshold."))
root = Card("Filter results", "Move the threshold to narrow the set locally.", [readout, slider, follow])`
