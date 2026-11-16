declare module '@hermes/plugin-sdk' {
  import type { ComponentType, ReactNode } from 'react'

  export interface ReadableAtom<T> {
    get(): T
  }

  export interface HermesGatewayEvent {
    readonly payload?: Readonly<Record<string, unknown>>
    readonly replayed?: boolean
    readonly session_id?: string
    readonly type: string
  }

  export interface TranscriptDirectiveProps {
    readonly attrs: Readonly<Record<string, string>>
    readonly sessionId: null | string
    readonly source: string
    readonly status?: 'complete' | 'error' | 'interrupted' | 'streaming'
    readonly streaming: boolean
  }

  export interface TranscriptDirectiveContribution {
    readonly name: string
    readonly render: (props: TranscriptDirectiveProps) => ReactNode
  }

  export interface PluginContribution {
    readonly area: string
    readonly data?: unknown
    readonly id: string
    readonly order?: number
    readonly render?: ComponentType
  }

  export interface PluginContext {
    readonly register: (contribution: PluginContribution) => () => void
    readonly onEvent: (type: string, listener: (event: HermesGatewayEvent) => void) => () => void
  }

  export interface HermesPlugin {
    readonly defaultEnabled?: boolean
    readonly description?: string
    readonly id: string
    readonly name?: string
    readonly register: (ctx: PluginContext) => void
  }

  export interface PluginComposer {
    readonly submit: (sessionId: null | string, text: string) => boolean
  }

  export interface PluginHost {
    readonly composer: PluginComposer
  }

  export const TRANSCRIPT_DIRECTIVE_AREA: string
  export const host: PluginHost
}
