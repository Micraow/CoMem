import { Renderer, type ActionEvent, type OpenUIError } from '@openuidev/react-lang'
import { useMemo, useRef, useState } from 'react'

import { openUILibrary } from './library.tsx'

const STATE_STORAGE_PREFIX = 'hermes.openui.state.v1'

const SURFACE_STYLES = `
.hermes-openui-surface {
  color: var(--ui-text-primary);
  font-family: var(--font-sans);
  line-height: var(--conversation-line-height, 1.5);
  max-width: 36rem;
  width: 100%;
}
.hermes-openui-card {
  background: var(--ui-widget-surface-background, var(--ui-bg-editor));
  border: 1px solid var(--ui-stroke-secondary);
  border-radius: 10px;
  box-sizing: border-box;
  display: grid;
  gap: 12px;
  padding: 12px 14px;
  width: 100%;
}
.hermes-openui-heading {
  display: grid;
  gap: 2px;
}
.hermes-openui-heading h3 {
  color: var(--ui-text-primary);
  font: inherit;
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.4;
  margin: 0;
}
.hermes-openui-heading p,
.hermes-openui-text {
  color: var(--ui-text-secondary);
  font: inherit;
  font-size: 0.8125rem;
  line-height: 1.45;
  margin: 0;
}
.hermes-openui-body {
  display: grid;
  gap: 10px;
}
.hermes-openui-slider {
  display: grid;
  gap: 6px;
}
.hermes-openui-slider-head {
  align-items: baseline;
  display: flex;
  font-size: 0.75rem;
  gap: 12px;
  justify-content: space-between;
  line-height: 1.35;
}
.hermes-openui-slider-head label {
  color: var(--ui-text-secondary);
}
.hermes-openui-slider-head output {
  color: var(--ui-text-primary);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.hermes-openui-slider input {
  accent-color: var(--ui-accent);
  cursor: pointer;
  margin: 0;
  width: 100%;
}
.hermes-openui-slider input:disabled {
  cursor: default;
  opacity: 0.55;
}
.hermes-openui-action {
  align-self: start;
  background: transparent;
  border: 1px solid var(--ui-stroke-secondary);
  border-radius: 6px;
  color: var(--ui-text-secondary);
  cursor: pointer;
  font: inherit;
  font-size: 0.75rem;
  justify-self: start;
  line-height: 1.35;
  min-height: 28px;
  padding: 4px 9px;
}
.hermes-openui-action:hover:not(:disabled) {
  background: var(--ui-control-hover-background);
  color: var(--ui-text-primary);
}
.hermes-openui-action:focus-visible,
.hermes-openui-slider input:focus-visible {
  outline: 2px solid var(--ui-accent);
  outline-offset: 2px;
}
.hermes-openui-action:disabled {
  cursor: default;
  opacity: 0.55;
}
.hermes-openui-error {
  color: var(--ui-text-secondary);
  font-size: 0.75rem;
  margin: 6px 0 0;
}
`

export interface OpenUISurfaceProps {
  /** Stable card identity, unique within its session. */
  readonly identity: string
  readonly onFollowUp?: (
    message: string,
    sessionId: string
  ) => boolean | Promise<boolean> | void
  readonly sessionId: null | string
  readonly source: string
  readonly streaming: boolean
}

interface SurfaceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function browserStorage(): SurfaceStorage | null {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    return (globalThis as { localStorage?: SurfaceStorage }).localStorage ?? null
  } catch {
    return null
  }
}

function storageKey(sessionId: null | string, identity: string): string {
  return `${STATE_STORAGE_PREFIX}:${encodeURIComponent(sessionId ?? '')}:${encodeURIComponent(identity)}`
}

function restoreState(key: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(browserStorage()?.getItem(key) ?? '')

    if (
      typeof value !== 'object' ||
      value === null ||
      !('version' in value) ||
      value.version !== 1 ||
      !('state' in value) ||
      typeof value.state !== 'object' ||
      value.state === null ||
      Array.isArray(value.state)
    ) {
      return undefined
    }

    return value.state as Record<string, unknown>
  } catch {
    return undefined
  }
}

function persistState(key: string, state: Record<string, unknown>): void {
  try {
    browserStorage()?.setItem(key, JSON.stringify({ state, version: 1 }))
  } catch {
    // Storage can be disabled or full; the mounted card remains usable.
  }
}

function actionableMessage(event: ActionEvent): string | null {
  if (event.type !== 'continue_conversation') {
    return null
  }

  const message = event.humanFriendlyMessage.trim()

  return message || null
}

export function OpenUISurface({
  identity,
  onFollowUp,
  sessionId,
  source,
  streaming
}: OpenUISurfaceProps) {
  const [errors, setErrors] = useState<readonly OpenUIError[]>([])
  const followedRef = useRef<string | null>(null)
  const visibleErrors = errors.filter(error => error.severity !== 'warning')
  const stateKey = storageKey(sessionId, identity)
  const initialState = useMemo(() => restoreState(stateKey), [stateKey])

  const handleAction = (event: ActionEvent) => {
    const message = actionableMessage(event)

    if (!message || !sessionId || !onFollowUp) {
      return
    }

    const followUpKey = `${sessionId}\u0000${message}`

    if (followedRef.current === followUpKey) {
      return
    }

    followedRef.current = followUpKey

    try {
      const result = onFollowUp(message, sessionId)

      if (result === false) {
        followedRef.current = null

        return
      }

      if (result && typeof result === 'object') {
        void result.then(
          accepted => {
            if (!accepted) {
              followedRef.current = null
            }
          },
          error => {
            followedRef.current = null
            console.error('[openui] follow-up failed', error)
          }
        )
      }
    } catch (error) {
      followedRef.current = null
      console.error('[openui] follow-up failed', error)
    }
  }

  return (
    <div
      className="hermes-openui-surface"
      data-hermes-openui-identity={identity}
      data-hermes-openui-surface
    >
      <style>{SURFACE_STYLES}</style>
      <Renderer
        initialState={initialState}
        isStreaming={streaming}
        key={stateKey}
        library={openUILibrary}
        onAction={handleAction}
        onError={nextErrors => setErrors(nextErrors)}
        onStateUpdate={state => persistState(stateKey, state)}
        response={source.trim() || null}
      />
      {!streaming && visibleErrors.length > 0 ? (
        <p className="hermes-openui-error" role="alert">
          This interface could not be displayed.
        </p>
      ) : null}
    </div>
  )
}
