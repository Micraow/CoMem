import { Renderer, type ActionEvent, type OpenUIError } from '@openuidev/react-lang'
import { useMemo, useRef, useState } from 'react'

import { INTELLIGENT_UI_STYLES } from './intelligent-ui/theme.ts'
import { openUILibrary } from './library.tsx'

const STATE_STORAGE_PREFIX = 'hermes.openui.state.v1'

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
    // Storage can be disabled or full; the mounted answer remains usable.
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
      <style>{INTELLIGENT_UI_STYLES}</style>
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
