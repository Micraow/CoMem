import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  openUIResponse,
  openUIDirective
} from '../src/stream.ts'

type GatewayEvent = {
  payload?: Record<string, unknown>
  replayed?: boolean
  session_id?: string
  type: string
}

type DirectiveProps = {
  attrs: Readonly<Record<string, string>>
  sessionId: null | string
  source: string
  status?: 'complete' | 'error' | 'interrupted' | 'streaming'
  streaming: boolean
}

type DirectiveContribution = {
  name: string
  render: (props: DirectiveProps) => unknown
}

type PluginModule = {
  default: {
    register: (ctx: {
      onEvent: (type: string, listener: (event: GatewayEvent) => void) => () => void
      register: (contribution: {
        area: string
        data?: unknown
        id: string
      }) => () => void
      rest: <T>(
        path: string,
        options?: {
          body?: unknown
          method?: string
          timeoutMs?: number
        }
      ) => Promise<T>
    }) => void
  }
  OPENUI_UNAVAILABLE: string
  createOpenUIQueryTools: (
    rest: <T>(
      path: string,
      options?: {
        body?: unknown
        method?: string
        timeoutMs?: number
      }
    ) => Promise<T>
  ) => Record<string, (args: Record<string, unknown>) => Promise<unknown>>
  submitOpenUIFollowUp: (sessionId: null | string, message: string) => boolean
}

declare global {
  var __openuiSubmissions: Array<{ sessionId: null | string; text: string }>
  var __openuiRestCalls: Array<{
    options?: { body?: unknown; method?: string; timeoutMs?: number }
    path: string
  }>
}

class MemoryStorage {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

function installStorage(storage = new MemoryStorage()): MemoryStorage {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage
  })
  return storage
}

async function loadPlugin(t: test.TestContext): Promise<PluginModule> {
  const workspace = process.cwd()
  const directory = await mkdtemp(path.join(workspace, '.plugin-test-'))
  t.after(() => rm(directory, { force: true, recursive: true }))

  const sdkStub = `
    const host = {
      composer: {
        submit(sessionId, text) {
          globalThis.__openuiSubmissions.push({ sessionId, text })
          return true
        }
      }
    }

    export const TRANSCRIPT_DIRECTIVE_AREA = 'transcript.directives'
    export { host }
  `
  const bundled = await build({
    absWorkingDir: workspace,
    bundle: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    entryPoints: ['src/plugin.tsx'],
    external: ['react', 'react/jsx-runtime', 'react-dom'],
    format: 'esm',
    jsx: 'automatic',
    loader: { '.css': 'text' },
    mainFields: ['module', 'main'],
    platform: 'node',
    plugins: [
      {
        name: 'hermes-plugin-sdk-stub',
        setup(buildApi) {
          buildApi.onResolve({ filter: /^@hermes\/plugin-sdk$/ }, () => ({
            namespace: 'hermes-sdk',
            path: 'stub'
          }))
          buildApi.onLoad({ filter: /.*/, namespace: 'hermes-sdk' }, () => ({
            contents: sdkStub,
            loader: 'js'
          }))
        }
      }
    ],
    write: false
  })
  const output = path.join(directory, 'plugin.mjs')

  await writeFile(output, bundled.outputFiles[0].text)
  return (await import(`${pathToFileURL(output).href}?test=${Date.now()}`)) as PluginModule
}

function installPlugin(plugin: PluginModule): {
  contribution: DirectiveContribution
  emit: (event: GatewayEvent) => void
} {
  let contribution: DirectiveContribution | undefined
  let listener: ((event: GatewayEvent) => void) | undefined

  plugin.default.register({
    onEvent(type, nextListener) {
      assert.equal(type, '*')
      listener = nextListener
      return () => undefined
    },
    register(entry) {
      assert.equal(entry.area, 'transcript.directives')
      contribution = entry.data as DirectiveContribution
      return () => undefined
    },
    async rest<T>(
      path: string,
      options?: { body?: unknown; method?: string; timeoutMs?: number }
    ): Promise<T> {
      globalThis.__openuiRestCalls.push({ options, path })
      return { rows: [{ id: 'row-1' }] } as T
    }
  })

  assert.equal(contribution?.name, 'openui')
  assert.ok(listener)

  return {
    contribution: contribution as DirectiveContribution,
    emit(event) {
      listener?.(event)
    }
  }
}

function start(runtimeId: string, turnId = 'turn-1'): GatewayEvent {
  return {
    payload: { turn_id: turnId },
    session_id: runtimeId,
    type: 'message.start'
  }
}

function delta(runtimeId: string, text: string, turnId = 'turn-1'): GatewayEvent {
  return {
    payload: { offset: 0, segment: 0, text, turn_id: turnId },
    session_id: runtimeId,
    type: 'message.delta'
  }
}

function complete(
  runtimeId: string,
  text: string,
  status: 'complete' | 'error' | 'interrupted' = 'complete',
  turnId = 'turn-1'
): GatewayEvent {
  return {
    payload: { status, text, turn_id: turnId },
    session_id: runtimeId,
    type: 'message.complete'
  }
}

function renderDirective(
  contribution: DirectiveContribution,
  {
    id,
    sessionId,
    status,
    streaming
  }: {
    id: string
    sessionId: null | string
    status?: DirectiveProps['status']
    streaming: boolean
  }
): string {
  return renderToStaticMarkup(
    contribution.render({
      attrs: { id },
      sessionId,
      source: openUIDirective(id),
      status,
      streaming
    }) as never
  )
}

test('keeps one directive mount around waiting and settled states', async t => {
  installStorage()
  globalThis.__openuiSubmissions = []
  const plugin = await loadPlugin(t)
  const { contribution } = installPlugin(plugin)

  const waiting = renderDirective(contribution, {
    id: 'ui-unknown',
    sessionId: 'stored-unknown',
    streaming: true
  })

  const finished = renderDirective(contribution, {
    id: 'ui-unknown',
    sessionId: 'stored-unknown',
    status: 'complete',
    streaming: false
  })

  assert.match(waiting, /class="hermes-openui-card-mount" data-hermes-openui-card/)
  assert.doesNotMatch(waiting, /Interactive card unavailable\./)
  assert.match(finished, /class="hermes-openui-card-mount" data-hermes-openui-card/)
  assert.match(finished, /Interactive card unavailable\./)
  assert.doesNotMatch(finished, /success/i)
})

test('renders a live card addressed by the directive stored id', async t => {
  installStorage()
  globalThis.__openuiSubmissions = []
  const plugin = await loadPlugin(t)
  const { contribution, emit } = installPlugin(plugin)
  const id = 'ui-live'

  emit({
    payload: { stored_session_id: 'stored-a' },
    session_id: 'runtime-a',
    type: 'session.info'
  })
  emit(start('runtime-a'))
  emit(delta('runtime-a', openUIResponse(id, 'root = Card("Scoped card")')))

  const html = renderToStaticMarkup(
    contribution.render({
      attrs: { id },
      sessionId: 'stored-a',
      source: openUIDirective(id),
      streaming: false
    }) as never
  )

  assert.match(html, /data-hermes-openui-identity="ui-live"/)
})

test('uses the fallback when a finished directive only has partial source', async t => {
  installStorage()
  globalThis.__openuiSubmissions = []
  const plugin = await loadPlugin(t)
  const { contribution, emit } = installPlugin(plugin)
  const id = 'ui-partial'
  const partial = `::openui{id="${id}"}\n\n<!--openui:source id="${id}"\nroot = Card("Partial card")`

  emit({
    payload: { stored_session_id: 'stored-partial' },
    session_id: 'runtime-partial',
    type: 'session.info'
  })
  emit(start('runtime-partial'))
  emit(delta('runtime-partial', partial))

  const live = renderDirective(contribution, {
    id,
    sessionId: 'stored-partial',
    streaming: true
  })
  const finished = renderDirective(contribution, {
    id,
    sessionId: 'stored-partial',
    streaming: false
  })

  assert.match(live, /data-hermes-openui-identity="ui-partial"/)
  assert.match(finished, /Interactive card unavailable\./)
})

test('targets the directive session when an action asks for a follow-up', async t => {
  installStorage()
  globalThis.__openuiSubmissions = []
  const plugin = await loadPlugin(t)

  assert.equal(plugin.submitOpenUIFollowUp('stored-a', ' Explain this '), true)
  assert.deepEqual(globalThis.__openuiSubmissions, [
    { sessionId: 'stored-a', text: 'Explain this' }
  ])
  assert.equal(plugin.submitOpenUIFollowUp(null, 'Explain this'), false)
})

test('query_data is an async, profile-scoped REST bridge', async t => {
  installStorage()
  globalThis.__openuiSubmissions = []
  globalThis.__openuiRestCalls = []
  const plugin = await loadPlugin(t)
  const tools = plugin.createOpenUIQueryTools(async <T>(
    path: string,
    options?: { body?: unknown; method?: string; timeoutMs?: number }
  ): Promise<T> => {
    globalThis.__openuiRestCalls.push({ options, path })
    return { rows: [{ id: 'row-1' }] } as T
  })

  assert.deepEqual(Object.keys(tools), ['query_data'])
  assert.deepEqual(await tools.query_data?.({window: '30d'}), {
    rows: [{ id: 'row-1' }]
  })
  assert.deepEqual(globalThis.__openuiRestCalls, [
    {
      options: {
        body: { arguments: { window: '30d' } },
        method: 'POST',
        timeoutMs: 15_000
      },
      path: '/query'
    }
  ])
})

test('persists under the durable id and reloads after the runtime id changes', async t => {
  const storage = installStorage()
  globalThis.__openuiSubmissions = []
  const id = 'ui-reload'
  const response = openUIResponse(id, 'root = Card("Durable card")')
  const first = installPlugin(await loadPlugin(t))

  first.emit({
    payload: { stored_session_id: 'stored-durable' },
    session_id: 'runtime-old',
    type: 'session.info'
  })
  first.emit(start('runtime-old'))
  first.emit(delta('runtime-old', response))
  first.emit(complete('runtime-old', response))

  const persisted = storage.getItem('hermes.openui.stream.v2') ?? ''

  assert.match(persisted, /"sessionId":"stored-durable"/)
  assert.doesNotMatch(persisted, /"sessionId":"runtime-old"/)

  const reloaded = installPlugin(await loadPlugin(t))
  const html = renderDirective(reloaded.contribution, {
    id,
    sessionId: 'stored-durable',
    streaming: false
  })

  assert.match(html, /data-hermes-openui-identity="ui-reload"/)
})

test('retires a failed session without leaking into another session card', async t => {
  installStorage()
  globalThis.__openuiSubmissions = []
  const plugin = await loadPlugin(t)
  const { contribution, emit } = installPlugin(plugin)
  const id = 'ui-interrupted'

  emit({
    payload: { stored_session_id: 'stored-b' },
    session_id: 'runtime-b',
    type: 'session.info'
  })
  emit(start('runtime-b'))
  emit(delta('runtime-b', openUIResponse(id, 'root = Card("Do not cache")')))
  emit({
    payload: {
      error: 'Interrupted by user',
      status: 'interrupted',
      text: openUIResponse(id, 'root = Card("Do not cache")'),
      turn_id: 'turn-1'
    },
    session_id: 'runtime-b',
    type: 'message.complete'
  })
  emit({
    payload: { stored_session_id: 'stored-c' },
    session_id: 'runtime-c',
    type: 'session.info'
  })
  emit(start('runtime-c'))
  emit(delta('runtime-c', openUIResponse(id, 'root = Card("Other session")')))

  const failedHtml = renderDirective(contribution, {
    id,
    sessionId: 'stored-b',
    status: 'interrupted',
    streaming: false
  })
  const activeHtml = renderDirective(contribution, {
    id,
    sessionId: 'stored-c',
    streaming: false
  })

  assert.match(failedHtml, /Interactive card unavailable\./)
  assert.match(activeHtml, /data-hermes-openui-identity="ui-interrupted"/)
})
