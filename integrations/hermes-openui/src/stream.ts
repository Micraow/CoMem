/**
 * Bridges Hermes gateway events to an inline OpenUI transcript directive.
 *
 * Assistant protocol:
 *
 *   ::openui{id="ui-abc123"}
 *
 *   <!--openui:source id="ui-abc123"
 *   root = Card(...)
 *   openui:end-->
 *
 * The directive is the stable React mount. Its ID must be globally unique
 * because it is also the browser-refresh cache key. Source stays in an HTML
 * comment, so the transcript shows the card instead of the program.
 */

export const OPENUI_DIRECTIVE_NAME = 'openui'
export const OPENUI_STORAGE_KEY = 'hermes.openui.stream.v2'

export type OpenUISourceState = 'waiting' | 'streaming' | 'complete'

export interface OpenUICardSnapshot {
  readonly complete: boolean
  readonly directiveSource: string
  readonly id: string
  readonly sessionId: string
  readonly source: string
  readonly sourceState: OpenUISourceState
  readonly streaming: boolean
  readonly turnId: string | null
  readonly updatedAt: number
}

export interface ParsedOpenUICard {
  readonly directiveSource: string
  readonly id: string
  readonly source: string
  readonly sourceState: OpenUISourceState
}

export interface HermesGatewayEventLike {
  readonly admission_id?: unknown
  readonly connectionId?: unknown
  readonly execution_generation?: unknown
  readonly payload?: {
    readonly offset?: unknown
    readonly rendered?: unknown
    readonly segment?: unknown
    readonly status?: unknown
    readonly text?: unknown
    readonly turn_id?: unknown
  }
  readonly profile?: unknown
  readonly replay_epoch?: unknown
  readonly replayed?: boolean
  readonly seq?: unknown
  readonly session_id?: string
  readonly type: string
}

export interface OpenUIStreamStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface OpenUIStreamStoreOptions {
  readonly maxActiveSessions?: number
  readonly maxCardsPerSession?: number
  readonly maxMessageChars?: number
  readonly maxPersistedCards?: number
  readonly maxSourceChars?: number
  readonly maxStoredChars?: number
  readonly now?: () => number
  readonly storage?: OpenUIStreamStorage | null
  readonly storageKey?: string
}

interface Turn {
  admissionId: string | null
  complete: boolean
  cursorOffset: number
  cursorSegment: number
  executionGeneration: number | null
  lastSeq: number | null
  lastSeqEpoch: string
  sessionId: string
  text: string
  turnId: string | null
  turnKey: string
}

interface LiveCard {
  snapshot: OpenUICardSnapshot
  turnKey: string
}

const DIRECTIVE_RE = /(?<=^|\s)::openui\{([^{}\n]{0,2048})\}/g
const ID_ATTR_RE =
  /(?:^|\s)id=(?:"([A-Za-z0-9][A-Za-z0-9._:-]{0,127})"|'([A-Za-z0-9][A-Za-z0-9._:-]{0,127})')/
const EMPTY_CARDS: readonly OpenUICardSnapshot[] = Object.freeze([])
const DEFAULT_MAX_ACTIVE_SESSIONS = 32
const DEFAULT_MAX_CARDS_PER_SESSION = 32
const DEFAULT_MAX_MESSAGE_CHARS = 1_000_000
const DEFAULT_MAX_PERSISTED_CARDS = 128
const DEFAULT_MAX_SOURCE_CHARS = 256_000
const DEFAULT_MAX_STORED_CHARS = 1_000_000
const STORAGE_OVERHEAD_CHARS = 16_384
const SOURCE_END_MARKER = '\nopenui:end-->'

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function cardKey(sessionId: string, id: string): string {
  return JSON.stringify([sessionId, id])
}

function browserStorage(): OpenUIStreamStorage | null {
  try {
    return (globalThis as { localStorage?: OpenUIStreamStorage }).localStorage ?? null
  } catch {
    return null
  }
}

export function openUIDirective(id: string): string {
  return `::openui{id="${id}"}`
}

export function openUISourceStart(id: string): string {
  return `<!--openui:source id="${id}"\n`
}

export function openUISourceEnd(): string {
  return SOURCE_END_MARKER
}

export function openUIResponse(id: string, source: string): string {
  return `${openUIDirective(id)}\n\n${openUISourceStart(id)}${source.trim()}${openUISourceEnd()}`
}

export function parseOpenUICards(text: string, messageComplete = false): ParsedOpenUICard[] {
  const cards: ParsedOpenUICard[] = []
  const matches = [...text.matchAll(DIRECTIVE_RE)]
  const seen = new Set<string>()

  for (const [index, match] of matches.entries()) {
    const idMatch = ID_ATTR_RE.exec(match[1] ?? '')
    const id = idMatch?.[1] ?? idMatch?.[2]

    if (!id || seen.has(id)) {
      continue
    }

    const directiveSource = match[0]
    const startMarker = openUISourceStart(id)
    const matchStart = match.index ?? 0
    const nextMatchStart = matches[index + 1]?.index ?? text.length
    const start = text.indexOf(startMarker, matchStart + directiveSource.length)

    if (start === -1 || start >= nextMatchStart) {
      continue
    }

    const bodyStart = start + startMarker.length
    const end = text.indexOf(SOURCE_END_MARKER, bodyStart)
    const boundedEnd = end !== -1 && end < nextMatchStart ? end : -1
    const rawSource = boundedEnd === -1
      ? text.slice(bodyStart, nextMatchStart)
      : text.slice(bodyStart, boundedEnd)
    const source = (boundedEnd === -1 && !messageComplete
      ? withholdPartialEndSuffix(rawSource)
      : rawSource
    ).replace(/^\r?\n/, '')

    if (!source.trim()) {
      continue
    }

    if (boundedEnd === -1 && messageComplete) {
      continue
    }

    seen.add(id)
    cards.push({
      directiveSource,
      id,
      source,
      sourceState: boundedEnd === -1 ? 'streaming' : 'complete'
    })
  }

  return cards
}

function withholdPartialEndSuffix(source: string): string {
  const maximum = Math.min(source.length, SOURCE_END_MARKER.length - 1)

  for (let length = maximum; length > 0; length -= 1) {
    if (source.endsWith(SOURCE_END_MARKER.slice(0, length))) {
      return source.slice(0, -length)
    }
  }

  return source
}

/**
 * One instance should live for the plugin's registered lifetime. Directive
 * renderers pass `getCard(sessionId, id)` to `useSyncExternalStore`; every
 * returned object remains stable until that card actually changes.
 */
export class OpenUIStreamStore {
  private readonly active = new Map<string, Turn>()
  private readonly cards = new Map<string, Map<string, LiveCard>>()
  private readonly listeners = new Set<() => void>()
  private readonly maxActiveSessions: number
  private readonly maxCardsPerSession: number
  private readonly maxMessageChars: number
  private readonly maxPersistedCards: number
  private readonly maxSourceChars: number
  private readonly maxStoredChars: number
  private readonly now: () => number
  private readonly persisted = new Map<string, OpenUICardSnapshot>()
  private readonly serials = new Map<string, number>()
  private readonly snapshots = new Map<string, readonly OpenUICardSnapshot[]>()
  private readonly storage: OpenUIStreamStorage | null
  private readonly storageKey: string

  constructor(options: OpenUIStreamStoreOptions = {}) {
    this.maxActiveSessions = positiveInteger(options.maxActiveSessions, DEFAULT_MAX_ACTIVE_SESSIONS)
    this.maxCardsPerSession = positiveInteger(
      options.maxCardsPerSession,
      DEFAULT_MAX_CARDS_PER_SESSION
    )
    this.maxMessageChars = positiveInteger(options.maxMessageChars, DEFAULT_MAX_MESSAGE_CHARS)
    this.maxPersistedCards = positiveInteger(
      options.maxPersistedCards,
      DEFAULT_MAX_PERSISTED_CARDS
    )
    this.maxSourceChars = positiveInteger(options.maxSourceChars, DEFAULT_MAX_SOURCE_CHARS)
    this.maxStoredChars = positiveInteger(options.maxStoredChars, DEFAULT_MAX_STORED_CHARS)
    this.now = options.now ?? Date.now
    this.storage = options.storage === undefined ? browserStorage() : options.storage
    this.storageKey = options.storageKey ?? OPENUI_STORAGE_KEY
    this.loadPersisted()
  }

  getCard = (sessionId: string | null | undefined, id: string): OpenUICardSnapshot | undefined =>
    sessionId
      ? this.cards.get(sessionId)?.get(id)?.snapshot ??
        this.persisted.get(cardKey(sessionId, id))
      : undefined

  getSessionCards(sessionId: string): readonly OpenUICardSnapshot[] {
    return this.snapshots.get(sessionId) ?? EMPTY_CARDS
  }

  getMessageText(sessionId: string): string {
    return this.active.get(sessionId)?.text ?? ''
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  handleEvent(event: HermesGatewayEventLike): boolean {
    const sessionId = stringValue(event.session_id)

    if (!sessionId) {
      return false
    }

    if (event.type === 'message.start') {
      this.touchActive(sessionId)
      this.start(sessionId, event)
    } else if (event.type === 'message.delta') {
      this.touchActive(sessionId)
      this.delta(sessionId, event)
    } else if (event.type === 'message.complete') {
      this.touchActive(sessionId)
      this.complete(sessionId, event)
    } else {
      return false
    }

    return true
  }

  private complete(sessionId: string, event: HermesGatewayEventLike): void {
    const turn = this.active.get(sessionId)

    if (!turn || turn.complete || !this.matchesTurn(turn, event) || !this.acceptSequence(turn, event)) {
      return
    }

    const finalText =
      stringValue(event.payload?.text) ?? stringValue(event.payload?.rendered)

    if (finalText !== null) {
      turn.text =
        finalText.length <= this.maxMessageChars
          ? finalText
          : finalText.slice(-this.maxMessageChars)
    }

    const status = stringValue(event.payload?.status)
    turn.complete = true
    this.refresh(turn, status === 'complete' ? 'success' : 'failure')
  }

  private createTurn(
    sessionId: string,
    turnId: string | null,
    event: HermesGatewayEventLike
  ): Turn {
    const serial = (this.serials.get(sessionId) ?? 0) + 1
    const turn: Turn = {
      admissionId: stringValue(event.admission_id),
      complete: false,
      cursorOffset: 0,
      cursorSegment: 0,
      executionGeneration: nonNegativeInteger(event.execution_generation),
      lastSeq: null,
      lastSeqEpoch: '',
      sessionId,
      text: '',
      turnId,
      turnKey: `${turnId ?? 'unkeyed'}:${serial}`
    }

    this.serials.set(sessionId, serial)
    this.active.set(sessionId, turn)
    this.acceptSequence(turn, event)
    this.pruneActiveSessions()
    return turn
  }

  private delta(sessionId: string, event: HermesGatewayEventLike): void {
    const text = typeof event.payload?.text === 'string' ? event.payload.text : null
    const turnId = stringValue(event.payload?.turn_id)
    let turn = this.active.get(sessionId)
    let created = false

    if (turn && !this.isFreshSequence(turn, event)) {
      return
    }

    if (turn?.complete) {
      if (
        this.matchesTurn(turn, event) &&
        (turnId !== null ||
          turn.admissionId !== null ||
          turn.executionGeneration !== null ||
          nonNegativeInteger(event.seq) !== null)
      ) {
        return
      }

      turn = undefined
    }

    if (!turn) {
      turn = this.createTurn(sessionId, turnId, event)
      created = true
    } else if (!this.matchesTurn(turn, event)) {
      if (turn.turnId && turnId && turn.turnId !== turnId) {
        return
      }

      turn = this.createTurn(sessionId, turnId, event)
      created = true
    } else if (!turn.turnId && turnId) {
      turn.turnId = turnId
    }

    this.adoptIdentity(turn, event)
    if (!created && !this.acceptSequence(turn, event)) {
      return
    }

    if (text === null || text.length === 0) {
      return
    }

    const segment = nonNegativeInteger(event.payload?.segment)
    const offset = nonNegativeInteger(event.payload?.offset)

    if (segment === null || offset === null) {
      this.appendTurnText(turn, text)
    } else {
      const end = offset + text.length

      if (segment < turn.cursorSegment || (segment === turn.cursorSegment && end <= turn.cursorOffset)) {
        return
      }

      this.appendTurnText(
        turn,
        segment === turn.cursorSegment && offset < turn.cursorOffset
          ? text.slice(turn.cursorOffset - offset)
          : text
      )
      turn.cursorSegment = segment
      turn.cursorOffset = end
    }

    this.refresh(turn, null)
  }

  private loadPersisted(): void {
    if (!this.storage) {
      return
    }

    try {
      const raw = this.storage.getItem(this.storageKey)

      if (!raw || raw.length > this.maxStoredChars + STORAGE_OVERHEAD_CHARS) {
        return
      }

      const value: unknown = JSON.parse(raw)
      if (typeof value !== 'object' || value === null) {
        return
      }

      const record = value as Record<string, unknown>
      if (record.version !== 2 || !Array.isArray(record.cards)) {
        return
      }

      for (const entry of record.cards) {
        if (typeof entry !== 'object' || entry === null) {
          continue
        }

        const card = entry as Record<string, unknown>
        const id = stringValue(card.id)
        const sessionId = stringValue(card.sessionId)
        const source = typeof card.source === 'string' ? card.source : null
        const updatedAt = nonNegativeInteger(card.updatedAt)

        if (
          id === null ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) ||
          sessionId === null ||
          source === null ||
          source.length > this.maxSourceChars ||
          updatedAt === null
        ) {
          continue
        }

        this.persisted.set(
          cardKey(sessionId, id),
          Object.freeze({
            complete: true,
            directiveSource: openUIDirective(id),
            id,
            sessionId,
            source,
            sourceState: 'complete',
            streaming: false,
            turnId: null,
            updatedAt
          })
        )
      }

      this.prunePersisted()
    } catch {
      // Disabled, corrupt, or quota-exhausted storage must not block the plugin.
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        console.error('[openui] stream subscriber failed', error)
      }
    }
  }

  private persist(card: OpenUICardSnapshot): void {
    if (
      !card.complete ||
      card.source.length === 0 ||
      card.source.length > this.maxSourceChars
    ) {
      return
    }

    const key = cardKey(card.sessionId, card.id)
    this.persisted.delete(key)
    this.persisted.set(key, card)
    this.prunePersisted()

    if (!this.storage) {
      return
    }

    try {
      this.storage.setItem(
        this.storageKey,
        JSON.stringify({
          version: 2,
          cards: [...this.persisted.values()].map(value => ({
            id: value.id,
            sessionId: value.sessionId,
            source: value.source,
            updatedAt: value.updatedAt
          }))
        })
      )
    } catch {
      // Live rendering continues when storage is unavailable.
    }
  }

  private prunePersisted(): void {
    let chars = 0
    for (const [key, card] of this.persisted) {
      chars += key.length + card.id.length + card.sessionId.length + card.source.length
    }

    while (
      this.persisted.size > this.maxPersistedCards ||
      (chars > this.maxStoredChars && this.persisted.size > 0)
    ) {
      const oldest = this.persisted.entries().next().value as [string, OpenUICardSnapshot] | undefined
      if (!oldest) {
        break
      }

      const [key, card] = oldest
      chars -= key.length + card.id.length + card.sessionId.length + card.source.length
      this.persisted.delete(key)
    }
  }

  private refresh(turn: Turn, terminal: 'failure' | 'success' | null): void {
    if (terminal === 'failure') {
      this.removeTurnCards(turn)
      return
    }

    const parsed = parseOpenUICards(turn.text, terminal === 'success').filter(
      card => card.source.length <= this.maxSourceChars
    )
    const current = this.cards.get(turn.sessionId) ?? new Map<string, LiveCard>()
    const ids = new Set(parsed.map(card => card.id))
    let changed = false

    if (terminal === 'success') {
      for (const [id, card] of current) {
        if (card.turnKey === turn.turnKey && !ids.has(id)) {
          current.delete(id)
          changed = true
        }
      }
    }

    for (const card of parsed) {
      const previous = current.get(card.id)?.snapshot
      const snapshot: OpenUICardSnapshot = Object.freeze({
        complete: card.sourceState === 'complete',
        directiveSource: card.directiveSource,
        id: card.id,
        sessionId: turn.sessionId,
        source: card.source,
        sourceState: card.sourceState,
        streaming: card.sourceState === 'streaming',
        turnId: turn.turnId,
        updatedAt: this.now()
      })

      if (
        !previous ||
        previous.complete !== snapshot.complete ||
        previous.directiveSource !== snapshot.directiveSource ||
        previous.source !== snapshot.source ||
        previous.streaming !== snapshot.streaming ||
        previous.turnId !== snapshot.turnId
      ) {
        current.delete(card.id)
        current.set(card.id, { snapshot, turnKey: turn.turnKey })
        changed = true
      } else {
        const live = current.get(card.id)
        if (live) {
          current.delete(card.id)
          current.set(card.id, live)
        }
      }
    }

    while (current.size > this.maxCardsPerSession) {
      const oldest = current.keys().next().value as string | undefined
      if (oldest === undefined) {
        break
      }

      current.delete(oldest)
      changed = true
    }
    this.cards.set(turn.sessionId, current)

    if (changed) {
      this.snapshots.set(
        turn.sessionId,
        Object.freeze([...current.values()].map(card => card.snapshot))
      )
      this.notify()
    }

    if (terminal === 'success') {
      for (const card of current.values()) {
        if (card.turnKey === turn.turnKey) {
          this.persist(card.snapshot)
        }
      }
    }
  }

  private start(sessionId: string, event: HermesGatewayEventLike): void {
    const turnId = stringValue(event.payload?.turn_id)
    const current = this.active.get(sessionId)

    if (current && !this.isFreshSequence(current, event)) {
      return
    }
    if (current) {
      this.acceptSequence(current, event)
    }

    if (
      current &&
      this.matchesTurn(current, event) &&
      (!current.complete ||
        turnId !== null ||
        current.turnId !== null ||
        stringValue(event.admission_id) !== null ||
        nonNegativeInteger(event.execution_generation) !== null ||
        event.replayed === true)
    ) {
      return
    }

    if (current && !current.complete) {
      current.complete = true
      this.refresh(current, 'failure')
    }

    this.createTurn(sessionId, turnId, event)
  }

  private acceptSequence(turn: Turn, event: HermesGatewayEventLike): boolean {
    if (!this.isFreshSequence(turn, event)) {
      return false
    }

    const seq = nonNegativeInteger(event.seq)
    if (seq !== null) {
      turn.lastSeq = seq
      turn.lastSeqEpoch = stringValue(event.replay_epoch) ?? turn.lastSeqEpoch
    }

    return true
  }

  private isFreshSequence(turn: Turn, event: HermesGatewayEventLike): boolean {
    const seq = nonNegativeInteger(event.seq)
    if (seq === null || turn.lastSeq === null) {
      return true
    }

    const epoch = stringValue(event.replay_epoch)
    if (epoch !== null && turn.lastSeqEpoch !== '' && epoch !== turn.lastSeqEpoch) {
      return true
    }

    if (seq <= turn.lastSeq) {
      return false
    }

    return true
  }

  private adoptIdentity(turn: Turn, event: HermesGatewayEventLike): void {
    turn.turnId ??= stringValue(event.payload?.turn_id)
    turn.admissionId ??= stringValue(event.admission_id)
    turn.executionGeneration ??= nonNegativeInteger(event.execution_generation)
  }

  private appendTurnText(turn: Turn, text: string): void {
    const next = turn.text + text
    turn.text =
      next.length <= this.maxMessageChars ? next : next.slice(-this.maxMessageChars)
  }

  private matchesTurn(turn: Turn, event: HermesGatewayEventLike): boolean {
    const turnId = stringValue(event.payload?.turn_id)
    const admissionId = stringValue(event.admission_id)
    const executionGeneration = nonNegativeInteger(event.execution_generation)

    if (turn.turnId !== null && turnId !== null && turn.turnId !== turnId) {
      return false
    }

    if (turn.admissionId !== null && turn.admissionId !== admissionId) {
      return false
    }

    return turn.executionGeneration === null || turn.executionGeneration === executionGeneration
  }

  private pruneActiveSessions(): void {
    while (this.active.size > this.maxActiveSessions) {
      const oldest = this.active.keys().next().value as string | undefined
      if (oldest === undefined) {
        break
      }

      this.active.delete(oldest)
      this.cards.delete(oldest)
      this.serials.delete(oldest)
      this.snapshots.delete(oldest)
    }
  }

  private touchActive(sessionId: string): void {
    const turn = this.active.get(sessionId)
    if (!turn) {
      return
    }

    this.active.delete(sessionId)
    this.active.set(sessionId, turn)
  }

  private removeTurnCards(turn: Turn): void {
    const current = this.cards.get(turn.sessionId)
    if (!current) {
      return
    }

    let changed = false
    for (const [id, card] of current) {
      if (card.turnKey === turn.turnKey) {
        current.delete(id)
        changed = true
      }
    }

    if (!changed) {
      return
    }

    this.cards.set(turn.sessionId, current)
    this.snapshots.set(
      turn.sessionId,
      Object.freeze([...current.values()].map(card => card.snapshot))
    )
    this.notify()
  }
}
