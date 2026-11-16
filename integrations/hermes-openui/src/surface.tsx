import { Renderer, type ActionEvent, type OpenUIError } from '@openuidev/react-lang'
import { useEffect, useMemo, useRef, useState } from 'react'

import { runLibraryAction } from './intelligent-ui/actions.ts'
import { OPENUI_STYLES } from './intelligent-ui/styles.ts'
import { openUILibrary } from './library.tsx'

const STATE_STORAGE_PREFIX = 'hermes.openui.state.v1'
type QueryToolProvider = Record<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
>

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
  readonly toolProvider?: null | QueryToolProvider
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

function openSafeUrl(event: ActionEvent): void {
  if (event.type !== 'open_url') {
    return
  }

  const value = event.params.url

  if (typeof value !== 'string') {
    return
  }

  try {
    const url = new URL(value)

    if (url.protocol === 'http:' || url.protocol === 'https:') {
      window.open(url.href, '_blank', 'noopener,noreferrer')
    }
  } catch {
    // Invalid and unsupported URLs are ignored without navigating the host.
  }
}

export function OpenUISurface({
  identity,
  onFollowUp,
  sessionId,
  source,
  streaming,
  toolProvider = null
}: OpenUISurfaceProps) {
  const [errors, setErrors] = useState<readonly OpenUIError[]>([])
  const followedRef = useRef<string | null>(null)
  const visibleErrors = errors.filter(error => error.severity !== 'warning')
  const stateKey = storageKey(sessionId, identity)
  const initialState = useMemo(() => restoreState(stateKey), [stateKey])
  const lastStateRef = useRef(initialState)
  const previousIdentityRef = useRef(identity)

  useEffect(() => {
    if (previousIdentityRef.current !== identity) {
      previousIdentityRef.current = identity
      lastStateRef.current = initialState
      return
    }

    if (lastStateRef.current) {
      persistState(stateKey, lastStateRef.current)
    }
  }, [identity, initialState, stateKey])

  const handleAction = (event: ActionEvent) => {
    openSafeUrl(event)
    void runLibraryAction(event)
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
      <style>{OPENUI_STYLES}</style>
      <Renderer
        initialState={initialState}
        isStreaming={streaming}
        key={identity}
        library={openUILibrary}
        onAction={handleAction}
        onError={nextErrors => setErrors(nextErrors)}
        onStateUpdate={state => {
          lastStateRef.current = state
          persistState(stateKey, state)
        }}
        response={source.trim() || null}
        toolProvider={toolProvider}
      >
        <div className="hermes-openui-renderer">
          <Renderer.Content />
          <Renderer.QueryLoading>
            <p className="hermes-openui-query-status" role="status">
              Loading data…
            </p>
          </Renderer.QueryLoading>
          <Renderer.QueryError>
            <div className="hermes-openui-query-status" role="alert">
              <span>The configured data source could not be loaded.</span>
              <Renderer.Retry type="button">Try again</Renderer.Retry>
            </div>
          </Renderer.QueryError>
        </div>
      </Renderer>
      {!streaming && visibleErrors.length > 0 ? (
        <p className="hermes-openui-error" role="alert">
          This interface could not be displayed.
        </p>
      ) : null}
    </div>
  )
}
