import {
  host,
  TRANSCRIPT_DIRECTIVE_AREA,
  type HermesGatewayEvent,
  type HermesPlugin,
  type TranscriptDirectiveContribution
} from '@hermes/plugin-sdk'
import { useSyncExternalStore } from 'react'

import { OpenUISurface } from './surface.tsx'
import { OpenUIStreamStore } from './stream.ts'

const OPENUI_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
export const OPENUI_UNAVAILABLE = 'Interactive card unavailable.'

type SessionPayload = Readonly<{
  stored_session_id?: unknown
}>

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * The directive renderer receives the durable session id, while gateway
 * message frames carry the runtime id. `session.info` supplies both ids.
 */
export class OpenUIBridge {
  private readonly storedByRuntime = new Map<string, string>()
  private readonly store = new OpenUIStreamStore()

  getCard = (sessionId: string | null | undefined, id: string) =>
    sessionId ? this.store.getCard(this.storedByRuntime.get(sessionId) ?? sessionId, id) : undefined

  handleEvent(event: HermesGatewayEvent): boolean {
    const runtimeId = stringValue(event.session_id)

    if (!runtimeId) {
      return false
    }

    const payload = event.payload as SessionPayload | undefined
    const informedStoredId = stringValue(payload?.stored_session_id)

    if (informedStoredId) {
      this.storedByRuntime.set(runtimeId, informedStoredId)
    }

    const storedId = informedStoredId ?? this.storedByRuntime.get(runtimeId)

    if (!storedId) {
      return false
    }

    return this.store.handleEvent({
      ...event,
      session_id: storedId
    })
  }

  subscribe = this.store.subscribe
}

function directiveId(attrs: Readonly<Record<string, string>>): string | null {
  const id = attrs.id?.trim() ?? ''
  return OPENUI_ID_RE.test(id) ? id : null
}

function OpenUIDirective({
  bridge,
  id,
  sessionId,
  status,
  streaming
}: {
  readonly bridge: OpenUIBridge
  readonly id: null | string
  readonly sessionId: null | string
  readonly status?: 'complete' | 'error' | 'interrupted' | 'streaming'
  readonly streaming: boolean
}) {
  const finished = status ? status !== 'streaming' : !streaming
  const getCardSnapshot = () => id ? bridge.getCard(sessionId, id) : undefined
  const card = useSyncExternalStore(
    bridge.subscribe,
    getCardSnapshot,
    getCardSnapshot
  )
  const usable =
    Boolean(id && sessionId && card?.source.trim()) &&
    (!finished || Boolean(card?.complete))

  if (!usable || !id || !sessionId || !card) {
    if (!finished) {
      return null
    }

    return (
      <p className="hermes-openui-unavailable" role="status">
        <style>{`
          .hermes-openui-unavailable {
            color: var(--ui-text-secondary);
            font-size: 0.75rem;
            margin: 6px 0;
          }
        `}</style>
        {OPENUI_UNAVAILABLE}
      </p>
    )
  }

  return (
    <OpenUISurface
      identity={id}
      onFollowUp={(message, destination) => submitOpenUIFollowUp(destination, message)}
      sessionId={sessionId}
      source={card.source}
      streaming={streaming || card.streaming}
    />
  )
}

export function submitOpenUIFollowUp(
  sessionId: null | string,
  message: string
): boolean {
  const destination = sessionId?.trim()
  const text = message.trim()

  return Boolean(destination && text && host.composer.submit(destination, text))
}

const plugin: HermesPlugin = {
  id: 'hermes-openui',
  name: 'OpenUI cards',
  description: 'Renders interactive OpenUI cards inside assistant replies.',
  register(ctx) {
    const bridge = new OpenUIBridge()
    const contribution: TranscriptDirectiveContribution = {
      name: 'openui',
      render: ({ attrs, sessionId, status, streaming }) => {
        const id = directiveId(attrs)

        return (
          <OpenUIDirective
            bridge={bridge}
            id={id}
            sessionId={sessionId}
            status={status}
            streaming={streaming}
          />
        )
      }
    }

    ctx.onEvent('*', event => {
      bridge.handleEvent(event)
    })

    ctx.register({
      id: 'transcript-directive',
      area: TRANSCRIPT_DIRECTIVE_AREA,
      data: contribution
    })
  }
}

export default plugin
