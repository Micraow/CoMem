import assert from 'node:assert/strict'
import test from 'node:test'

import {
  type OpenUIStreamStorage,
  OpenUIStreamStore,
  openUIResponse,
  openUISourceEnd,
  openUISourceStart,
  parseOpenUICards
} from '../src/stream.ts'

class MemoryStorage implements OpenUIStreamStorage {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

const start = (sessionId: string, turnId: string, replayed = false) => ({
  type: 'message.start',
  session_id: sessionId,
  replayed,
  payload: { turn_id: turnId }
})

const delta = (sessionId: string, turnId: string, text: string, offset: number, segment = 0) => ({
  type: 'message.delta',
  session_id: sessionId,
  payload: { offset, segment, text, turn_id: turnId }
})

const complete = (
  sessionId: string,
  text?: string,
  status: unknown = 'complete',
  extra: Record<string, unknown> = {}
) => ({
  type: 'message.complete',
  session_id: sessionId,
  ...extra,
  payload: {
    status,
    ...(typeof text === 'string' ? { text } : {})
  }
})

test('uses one HTML comment for the source envelope', () => {
  assert.equal(
    openUIResponse('ui-protocol', 'root = Card("ok")'),
    '::openui{id="ui-protocol"}\n\n<!--openui:source id="ui-protocol"\nroot = Card("ok")\nopenui:end-->'
  )
})

test('parses source that is split through every protocol boundary', () => {
  const id = 'ui-chunked'
  const directive = `::openui{id="${id}"}`
  const expected = 'root = Card("checkout", { count: 3 })'
  const chunks = [
    `\n\n${openUISourceStart(id).slice(0, 9)}`,
    openUISourceStart(id).slice(9),
    `\n${expected.slice(0, 11)}`,
    expected.slice(11),
    openUISourceEnd()
  ]
  const store = new OpenUIStreamStore({ storage: null, now: () => 7 })

  store.handleEvent(start('session-a', 'turn-1'))

  let full = directive.slice(0, 7)
  let offset = 0

  store.handleEvent({
    type: 'message.delta',
    session_id: 'session-a',
    payload: { offset, segment: 0, text: full, turn_id: 'turn-1' }
  })
  offset += full.length
  const directiveTail = directive.slice(7)
  store.handleEvent(delta('session-a', 'turn-1', directiveTail, offset))
  full += directiveTail
  offset += directiveTail.length

  for (const chunk of chunks) {
    store.handleEvent(delta('session-a', 'turn-1', chunk, offset))
    full += chunk
    offset += chunk.length

    const card = store.getCard('session-a', id)
    assert.equal(card?.sourceState, chunk === openUISourceEnd() ? 'complete' : card?.sourceState)
  }

  const card = store.getCard('session-a', id)

  assert.equal(card?.directiveSource, directive)
  assert.equal(card?.source, expected)
  assert.equal(card?.streaming, false)
  assert.equal(store.getMessageText('session-a'), full)
})

test('exposes nonempty partial source before the closing marker', () => {
  const directive = '::openui{id="ui-live"}'
  const text = `${directive}\n\n${openUISourceStart('ui-live')}root = Card("live`
  const store = new OpenUIStreamStore({ storage: null })

  store.handleEvent(start('session-a', 'turn-1'))
  store.handleEvent(delta('session-a', 'turn-1', text, 0))

  const [parsed] = parseOpenUICards(text)
  const card = store.getCard('session-a', 'ui-live')

  assert.equal(parsed?.source, 'root = Card("live')
  assert.equal(parsed?.sourceState, 'streaming')
  assert.equal(card?.source, 'root = Card("live')
  assert.equal(card?.sourceState, 'streaming')
  assert.equal(card?.complete, false)
  assert.equal(card?.streaming, true)
  assert.equal(store.getSessionCards('session-a').length, 1)
})

test('withholds a partial end suffix without replacing the live snapshot', () => {
  const id = 'ui-stable'
  const directive = `::openui{id="${id}"}`
  const program = `${directive}\n\n${openUISourceStart(id)}root = Card("stable")`
  const store = new OpenUIStreamStore({ storage: null })

  store.handleEvent(start('session-a', 'turn-1', false))
  store.handleEvent(delta('session-a', 'turn-1', program, 0))
  const beforeSuffix = store.getCard('session-a', id)
  const suffix = '\nopenui:end--'

  store.handleEvent(delta('session-a', 'turn-1', suffix, program.length))
  const afterSuffix = store.getCard('session-a', id)

  assert.equal(afterSuffix, beforeSuffix)
  assert.equal(afterSuffix?.source, 'root = Card("stable")')
  assert.equal(afterSuffix?.streaming, true)

  store.handleEvent(delta('session-a', 'turn-1', '>', program.length + suffix.length))
  const closed = store.getCard('session-a', id)

  assert.equal(closed?.source, 'root = Card("stable")')
  assert.equal(closed?.complete, true)
  assert.equal(closed?.streaming, false)
})

test('never caches a successful terminal response without an end marker', () => {
  const storage = new MemoryStorage()
  const id = 'ui-no-end'
  const response = `::openui{id="${id}"}\n\n${openUISourceStart(id)}root = Card("open")`
  const store = new OpenUIStreamStore({ storage })

  store.handleEvent(start('session-a', 'turn-1'))
  store.handleEvent(delta('session-a', 'turn-1', response, 0))
  assert.equal(store.getCard('session-a', id)?.streaming, true)

  store.handleEvent(complete('session-a', response, 'complete'))

  assert.equal(store.getCard('session-a', id), undefined)
  assert.equal(new OpenUIStreamStore({ storage }).getCard('session-a', id), undefined)
})

test('uses message.complete text as the authoritative final source', () => {
  const store = new OpenUIStreamStore({ storage: null })
  const id = 'ui-final'

  store.handleEvent(start('session-a', 'turn-1'))
  store.handleEvent(delta('session-a', 'turn-1', 'not final', 0))

  const final = openUIResponse(id, 'root = Card("final")')

  store.handleEvent(complete('session-a', final))

  assert.equal(store.getMessageText('session-a'), final)
  assert.equal(store.getCard('session-a', id)?.source, 'root = Card("final")')
  assert.equal(store.getCard('session-a', id)?.complete, true)
})

test('drops duplicate and stale stamped deltas', () => {
  const store = new OpenUIStreamStore({ storage: null })
  const id = 'ui-dedupe'
  const prefix = `::openui{id="${id}"}\n\n${openUISourceStart(id)}\n`
  const first = 'root = '
  const second = 'Card("ok")'

  store.handleEvent(start('session-a', 'turn-1'))
  store.handleEvent(delta('session-a', 'turn-1', prefix, 0))
  store.handleEvent(delta('session-a', 'turn-1', first, prefix.length))
  store.handleEvent(delta('session-a', 'turn-1', first, prefix.length))
  store.handleEvent(delta('session-a', 'turn-1', `${first.slice(3)}${second}`, prefix.length + 3))

  assert.equal(store.getMessageText('session-a'), `${prefix}${first}${second}`)
})

test('ignores a late delta from the previous turn', () => {
  const store = new OpenUIStreamStore({ storage: null })

  store.handleEvent(start('session-a', 'turn-2'))
  store.handleEvent(delta('session-a', 'turn-1', 'stale', 0))
  store.handleEvent(delta('session-a', 'turn-2', 'fresh', 0))

  assert.equal(store.getMessageText('session-a'), 'fresh')
})

test('keeps simultaneous sessions isolated', () => {
  const store = new OpenUIStreamStore({ storage: null })
  const id = 'ui-shared-id'

  store.handleEvent(start('session-a', 'turn-a'))
  store.handleEvent(start('session-b', 'turn-b'))
  store.handleEvent(
    delta('session-a', 'turn-a', openUIResponse(id, 'root = Card("A")'), 0)
  )
  store.handleEvent(
    delta('session-b', 'turn-b', openUIResponse(id, 'root = Card("B")'), 0)
  )

  assert.equal(store.getCard('session-a', id)?.source, 'root = Card("A")')
  assert.equal(store.getCard('session-b', id)?.source, 'root = Card("B")')
  assert.equal(store.getSessionCards('session-a').length, 1)
  assert.equal(store.getSessionCards('session-b').length, 1)
})

test('does not let a replayed start erase the live turn', () => {
  const store = new OpenUIStreamStore({ storage: null })
  const id = 'ui-replay-start'

  store.handleEvent(start('session-a', 'turn-1'))
  store.handleEvent(delta('session-a', 'turn-1', openUIResponse(id, 'root = Card("kept")'), 0))
  store.handleEvent(start('session-a', 'turn-1', true))

  assert.equal(store.getCard('session-a', id)?.source, 'root = Card("kept")')
})

test('restores a completed card after browser refresh', () => {
  const storage = new MemoryStorage()
  const id = 'ui-refresh'
  const response = openUIResponse(id, 'root = Card("persisted")')
  const first = new OpenUIStreamStore({ storage, now: () => 42 })

  first.handleEvent(start('session-a', 'turn-1'))
  first.handleEvent(delta('session-a', 'turn-1', response, 0))
  first.handleEvent(complete('session-a', response))

  const refreshed = new OpenUIStreamStore({ storage, now: () => 99 })
  const restored = refreshed.getCard('session-a', id)

  assert.equal(restored?.source, 'root = Card("persisted")')
  assert.equal(restored?.complete, true)
  assert.equal(restored?.updatedAt, 42)
  assert.equal(refreshed.getCard('session-a', id), restored)
})

test('does not restore legacy cache entries without a success contract', () => {
  const storage = new MemoryStorage()
  storage.setItem(
    'hermes.openui.stream.v1',
    JSON.stringify({
      version: 1,
      cards: {
        'ui-legacy': {
          sessionId: 'session-a',
          source: 'root = Card("legacy")',
          updatedAt: 1
        }
      }
    })
  )

  assert.equal(new OpenUIStreamStore({ storage }).getCard('session-a', 'ui-legacy'), undefined)
})

test('never caches an interrupted, failed, or status-less response', () => {
  const storage = new MemoryStorage()
  const store = new OpenUIStreamStore({ storage })

  for (const [index, status] of ['interrupted', 'error', undefined].entries()) {
    const sessionId = `session-${index}`
    const id = `ui-${index}`
    const response = openUIResponse(id, `root = Card("${status ?? 'unknown'}")`)

    store.handleEvent(start(sessionId, `turn-${index}`))
    store.handleEvent(delta(sessionId, `turn-${index}`, response, 0))
    assert.equal(store.getCard(sessionId, id)?.complete, true)

    store.handleEvent(
      status === undefined
        ? {
            type: 'message.complete',
            session_id: sessionId,
            payload: { text: response }
          }
        : complete(sessionId, response, status)
    )

    assert.equal(store.getCard(sessionId, id), undefined)
    assert.equal(new OpenUIStreamStore({ storage }).getCard(sessionId, id), undefined)
  }
})

test('a terminal event from an older admission cannot close the live turn', () => {
  const store = new OpenUIStreamStore({ storage: null })
  const first = openUIResponse('ui-first', 'root = Card("first")')
  const second = openUIResponse('ui-second', 'root = Card("second")')

  store.handleEvent({
    type: 'message.start',
    session_id: 'session-a',
    admission_id: 'admission-1',
    execution_generation: 1,
    payload: { turn_id: 'turn-1' }
  })
  store.handleEvent({
    type: 'message.delta',
    session_id: 'session-a',
    admission_id: 'admission-1',
    execution_generation: 1,
    payload: { offset: 0, segment: 0, text: first, turn_id: 'turn-1' }
  })

  store.handleEvent({
    type: 'message.start',
    session_id: 'session-a',
    admission_id: 'admission-2',
    execution_generation: 2,
    payload: { turn_id: 'turn-2' }
  })
  store.handleEvent({
    type: 'message.delta',
    session_id: 'session-a',
    admission_id: 'admission-2',
    execution_generation: 2,
    payload: { offset: 0, segment: 0, text: second, turn_id: 'turn-2' }
  })

  store.handleEvent(
    complete('session-a', first, 'complete', {
      admission_id: 'admission-1',
      execution_generation: 1
    })
  )

  assert.equal(store.getMessageText('session-a'), second)
  assert.equal(store.getCard('session-a', 'ui-first'), undefined)
  assert.equal(store.getCard('session-a', 'ui-second')?.source, 'root = Card("second")')

  store.handleEvent(
    complete('session-a', second, 'complete', {
      admission_id: 'admission-2',
      execution_generation: 2
    })
  )

  assert.equal(store.getCard('session-a', 'ui-second')?.complete, true)
})

test('persists the same card id independently for each session', () => {
  const storage = new MemoryStorage()
  const first = new OpenUIStreamStore({ storage })
  const id = 'ui-shared-id'

  for (const [sessionId, label] of [
    ['session-a', 'A'],
    ['session-b', 'B']
  ] as const) {
    const response = openUIResponse(id, `root = Card("${label}")`)
    first.handleEvent(start(sessionId, `turn-${label}`))
    first.handleEvent(delta(sessionId, `turn-${label}`, response, 0))
    first.handleEvent(complete(sessionId, response))
  }

  const refreshed = new OpenUIStreamStore({ storage })

  assert.equal(refreshed.getCard('session-a', id)?.source, 'root = Card("A")')
  assert.equal(refreshed.getCard('session-b', id)?.source, 'root = Card("B")')
  assert.equal(refreshed.getCard('session-c', id), undefined)
})

test('bounds live sessions and persisted cards', () => {
  const storage = new MemoryStorage()
  const store = new OpenUIStreamStore({
    storage,
    maxActiveSessions: 2,
    maxCardsPerSession: 1,
    maxPersistedCards: 2
  })
  const id = 'ui-bounded'

  for (const label of ['A', 'B', 'C']) {
    const sessionId = `session-${label}`
    const response = [
      openUIResponse(`ui-old-${label}`, `root = Card("old ${label}")`),
      openUIResponse(id, `root = Card("${label}")`)
    ].join('\n\n')
    store.handleEvent(start(sessionId, `turn-${label}`))
    store.handleEvent(delta(sessionId, `turn-${label}`, response, 0))
    store.handleEvent(complete(sessionId, response))
  }

  assert.equal(store.getCard('session-A', id), undefined)
  assert.equal(store.getCard('session-B', id)?.source, 'root = Card("B")')
  assert.equal(store.getCard('session-C', id)?.source, 'root = Card("C")')
  assert.equal(store.getSessionCards('session-B').length, 1)
  assert.equal(store.getCard('session-B', 'ui-old-B'), undefined)

  const persisted = JSON.parse(storage.getItem('hermes.openui.stream.v2') ?? '') as {
    cards?: unknown[]
  }
  assert.equal(persisted.cards?.length, 2)
})

test('uses the runtime seq only for unstamped delta dedupe', () => {
  const store = new OpenUIStreamStore({ storage: null })

  store.handleEvent({ type: 'message.start', session_id: 'session-a', seq: 1 })
  store.handleEvent({
    type: 'message.delta',
    session_id: 'session-a',
    seq: 3,
    payload: { text: 'fresh' }
  })
  store.handleEvent({
    type: 'message.delta',
    session_id: 'session-a',
    seq: 2,
    payload: { text: 'stale' }
  })

  assert.equal(store.getMessageText('session-a'), 'fresh')
})

test('leaves ordinary assistant replies untouched', () => {
  const store = new OpenUIStreamStore({ storage: null })

  store.handleEvent(start('session-a', 'turn-1'))
  store.handleEvent(delta('session-a', 'turn-1', 'plain text', 0))
  store.handleEvent(complete('session-a', 'plain text'))

  assert.equal(store.getSessionCards('session-a').length, 0)
  assert.equal(store.getMessageText('session-a'), 'plain text')
})

test('keeps old cards when consecutive turns have no turn_id', () => {
  const store = new OpenUIStreamStore({ storage: null })
  const first = openUIResponse('ui-first', 'root = Card("first")')
  const second = openUIResponse('ui-second', 'root = Card("second")')

  store.handleEvent({ type: 'message.start', session_id: 'session-a' })
  store.handleEvent({
    type: 'message.delta',
    session_id: 'session-a',
    payload: { text: first }
  })
  store.handleEvent(complete('session-a', first))

  store.handleEvent({ type: 'message.start', session_id: 'session-a' })
  store.handleEvent({
    type: 'message.delta',
    session_id: 'session-a',
    payload: { text: second }
  })
  store.handleEvent(complete('session-a', second))

  assert.equal(store.getCard('session-a', 'ui-first')?.source, 'root = Card("first")')
  assert.equal(store.getCard('session-a', 'ui-second')?.source, 'root = Card("second")')
  assert.equal(store.getSessionCards('session-a').length, 2)
})
