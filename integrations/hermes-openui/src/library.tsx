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
import { useId } from 'react'
import { z } from 'zod/v4'

const node = z.any()
tagSchemaId(node, 'Node')

const Card = defineComponent({
  name: 'Card',
  description: 'Compact result card with a title and optional supporting text.',
  props: z.object({
    title: z.string(),
    description: z.string().optional(),
    children: z.array(node)
  }),
  component: ({ props, renderNode }) => (
    <section className="hermes-openui-card" data-hermes-openui-card>
      <header className="hermes-openui-heading">
        <h3>{props.title}</h3>
        {props.description ? <p>{props.description}</p> : null}
      </header>
      <div className="hermes-openui-body">{renderNode(props.children)}</div>
    </section>
  )
})

const Text = defineComponent({
  name: 'Text',
  description: 'One short line that may depend on slider state.',
  props: z.object({
    text: z.string()
  }),
  component: ({ props }) => <p className="hermes-openui-text">{props.text}</p>
})

function displayValue(value: number, unit: string): string {
  const number = value.toLocaleString('en-US', { maximumFractionDigits: 2 })

  return /^[$€£¥₹]$/.test(unit.trim()) ? `${unit.trim()}${number}` : `${number}${unit}`
}

const Slider = defineComponent({
  name: 'Slider',
  description: 'A local numeric filter. Pass a reactive $variable as value.',
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
    // reactive() widens the prop type; the hook unwraps the runtime binding itself.
    const field = useStateField<number>(statementId ?? props.label, props.value as unknown as number)
    const id = useId()
    const min = Math.min(props.min, props.max)
    const max = Math.max(props.min, props.max)
    const step = props.step && props.step > 0 ? props.step : 1
    const numeric = typeof field.value === 'number' && Number.isFinite(field.value) ? field.value : min
    const value = Math.min(max, Math.max(min, numeric))
    const readout = displayValue(value, props.unit ?? '')

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
  description: 'One explicit follow-up action in the card.',
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
  id: 'hermes-openui-filter-card',
  root: 'Card',
  components: [Card, Text, Slider, Button]
})

export const OPENUI_PROMPT = openUILibrary.prompt({
  preamble:
    'Create one compact interactive card for a Hermes assistant answer. Use local state for controls and keep the card focused on the current task.',
  additionalRules: [
    'Use Card as the root and include only Text, Slider, and Button below it.',
    'Bind the Slider value to a $variable and make at least one Text statement read that variable.',
    'Controls must update visible content locally; do not add controls whose values are never displayed or used.',
    'End with exactly one follow-up Button whose action is one @ToAssistant message. The message is useful only when the visible local result is insufficient.'
  ],
  examples: [
    `threshold = $minimum
readout = Text("Showing results at or above " + $minimum + "% relevance.")
slider = Slider($minimum, 0, 100, 5, "Minimum relevance", "%")
follow = Button("Explain these results", @ToAssistant("Explain the current results at this threshold."))
root = Card("Filter results", "Move the threshold to narrow the set locally.", [readout, slider, follow])`
  ]
})

export const SAMPLE_OPENUI_PROGRAM = `$minimum = 70
readout = Text("Showing results with at least " + $minimum + "% relevance.")
slider = Slider($minimum, 0, 100, 5, "Minimum relevance", "%")
follow = Button("Explain these results", @ToAssistant("Explain the current results at this relevance threshold."))
root = Card("Filter results", "Move the threshold to narrow the set locally.", [readout, slider, follow])`
