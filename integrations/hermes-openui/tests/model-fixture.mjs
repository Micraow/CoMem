import http from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

export const DEFAULT_FIXTURE_HOST = '127.0.0.1'
export const DEFAULT_FIXTURE_PORT = 19121
export const DEFAULT_CHUNK_DELAY_MS = 90
export const DEFAULT_HALFWAY_PAUSE_MS = 5_000
export const DEFAULT_END_DELAY_MS = 750
export const FIXTURE_MODEL_ID = 'stream-fixture'

export const PRIMARY_PROMPT = 'Please make a streaming card for this test.'
export const SECOND_SESSION_PROMPT =
  'Please make the second OpenUI example in a separate session.'
export const FOLLOW_UP_TEXT =
  'Explain the current results at this relevance threshold.'

export const DEFAULT_PRIMARY_PROGRAM = `$minimum = 70
readout = Text("Showing results with at least " + $minimum + "% relevance.")
slider = Slider($minimum, 0, 100, 5, "Minimum relevance", "%")
follow = Button("Explain these results", @ToAssistant("Explain the current results at this relevance threshold."))
root = Card("Filter results", "Move the threshold to narrow the set locally.", [readout, slider, follow])`

// A reference integration can replace this at startup. Keeping a local
// fallback lets this Node fixture run without importing application TSX.
export const DEFAULT_SECONDARY_PROGRAM = DEFAULT_PRIMARY_PROGRAM

export const FIXTURE_PHASES = Object.freeze([
  'idle',
  'streaming',
  'partialSource',
  'sourceEnded',
  'complete',
  'interrupted'
])

const model = {
  id: FIXTURE_MODEL_ID,
  object: 'model',
  created: 0,
  owned_by: 'fixture'
}

function integerEnv(name, fallback, { allowZero = false, maximum = Infinity } = {}) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') {
    return fallback
  }

  const value = Number(raw)
  if (
    !Number.isInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    value > maximum
  ) {
    throw new RangeError(`${name} must be an integer from ${allowZero ? 0 : 1} to ${maximum}`)
  }

  return value
}

export function resolveFixturePort(value = process.env.OPENUI_FIXTURE_PORT) {
  if (value === undefined || String(value).trim() === '') {
    return DEFAULT_FIXTURE_PORT
  }

  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError('OPENUI_FIXTURE_PORT must be an integer from 1 to 65535')
  }

  return port
}

function textContent(content) {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return ''
  }

  return content
    .map(part => {
      if (typeof part === 'string') {
        return part
      }

      return typeof part?.text === 'string' ? part.text : ''
    })
    .join('')
}

export function promptFromRequest(request) {
  const messages = Array.isArray(request?.messages) ? request.messages : []
  const latestUser = messages.findLast(message => message?.role === 'user')
  return textContent(latestUser?.content).trim()
}

export function classifyFixturePrompt(request) {
  const prompt = promptFromRequest(request)
  const lower = prompt.toLowerCase()
  const messages = Array.isArray(request?.messages) ? request.messages : []

  if (
    lower.includes('second openui') ||
    lower.includes('second session') ||
    prompt.includes(SECOND_SESSION_PROMPT)
  ) {
    return { kind: 'secondary', prompt }
  }

  if (
    lower.includes('make a streaming card') ||
    lower.includes('streaming openui')
  ) {
    return { kind: 'primary', prompt }
  }

  const hasPriorCard = messages.some(message => {
    const text = textContent(message?.content)
    return message?.role === 'assistant' && text.includes('::openui{')
  })

  if (hasPriorCard || /current results.*relevance|explain these results/i.test(prompt)) {
    return { kind: 'followup', prompt }
  }

  return { kind: 'plain', prompt }
}

/**
 * Pure response generator. Source lines are separate chunks; the final source
 * line carries `partialSource`, and the closing marker is a later chunk.
 */
export function createFixtureResponse({
  id,
  program,
  closing = 'The full reply is finished.'
}) {
  if (!id || typeof id !== 'string') {
    throw new TypeError('createFixtureResponse requires a nonempty id')
  }
  if (!program || typeof program !== 'string') {
    throw new TypeError('createFixtureResponse requires a nonempty program')
  }

  const source = program.trim()
  const sourceLines = source.split('\n')
  const chunks = [
    { text: 'Here is the interactive view.\n\n', phase: 'streaming' },
    { text: `::openui{id="${id}"}`, phase: 'streaming' },
    { text: `\n\n<!--openui:source id="${id}"\n`, phase: 'streaming' },
    ...sourceLines.map((line, index) => ({
      text: `${index === 0 ? '' : '\n'}${line}`,
      phase: index === sourceLines.length - 1 ? 'partialSource' : 'streaming'
    })),
    { text: '\nopenui:end-->', phase: 'sourceEnded' },
    { text: `\n\n${closing}` }
  ]

  return Object.freeze({
    id,
    source,
    text: chunks.map(chunk => chunk.text).join(''),
    chunks: Object.freeze(chunks.map(chunk => Object.freeze({ ...chunk })))
  })
}

function event(id, content, finishReason = null) {
  let delta = {}
  if (content !== undefined) {
    delta = { role: 'assistant', content }
  }
  return {
    id,
    object: 'chat.completion.chunk',
    created: 0,
    model: FIXTURE_MODEL_ID,
    choices: [{
      index: 0,
      delta,
      finish_reason: finishReason
    }]
  }
}

function usageEvent(id, text) {
  const promptTokens = 1
  const completionTokens = Math.max(1, Math.ceil(text.length / 4))

  return {
    id,
    object: 'chat.completion.chunk',
    created: 0,
    model: FIXTURE_MODEL_ID,
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens
    }
  }
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body)
  })
  response.end(body)
}

function sendSse(response, value) {
  if (response.destroyed || response.writableEnded) {
    return false
  }

  const body = typeof value === 'string' ? value : JSON.stringify(value)
  response.write(`data: ${body}\n\n`)
  return true
}

async function wait(ms, signal) {
  if (ms <= 0) {
    return true
  }

  try {
    await delay(ms, undefined, { signal })
    return true
  } catch (error) {
    if (error?.name === 'AbortError') {
      return false
    }

    throw error
  }
}

async function readJson(request) {
  let body = ''

  for await (const chunk of request) {
    body += chunk
    if (body.length > 1_000_000) {
      throw new RangeError('request body exceeds 1 MB')
    }
  }

  return body ? JSON.parse(body) : {}
}

export async function startModelFixture(options = {}) {
  const host = options.host ?? process.env.OPENUI_FIXTURE_HOST ?? DEFAULT_FIXTURE_HOST
  const port = options.port ?? resolveFixturePort()
  const chunkDelayMs = options.chunkDelayMs ??
    integerEnv('OPENUI_FIXTURE_CHUNK_DELAY_MS', DEFAULT_CHUNK_DELAY_MS, {
      allowZero: true
    })
  const halfwayPauseMs = options.halfwayPauseMs ??
    integerEnv('OPENUI_FIXTURE_HALFWAY_PAUSE_MS', DEFAULT_HALFWAY_PAUSE_MS, {
      allowZero: true
    })
  const endDelayMs = options.endDelayMs ??
    integerEnv('OPENUI_FIXTURE_END_DELAY_MS', DEFAULT_END_DELAY_MS, {
      allowZero: true
    })
  const primaryProgram = options.primaryProgram ?? DEFAULT_PRIMARY_PROGRAM
  const secondaryProgram = options.secondaryProgram ?? DEFAULT_SECONDARY_PROGRAM

  const counters = {
    requests: 0,
    streams: 0,
    cardStarts: 0,
    partialSourceSent: 0,
    sourceEnded: 0,
    completed: 0,
    interrupted: 0,
    responsesCompleted: 0,
    responsesInterrupted: 0,
    followups: 0,
    secondSessionStarts: 0
  }
  const sessions = new Map()
  const activeControllers = new Map()
  let nextRequest = 1
  let phase = 'idle'

  const updatePhase = (session, nextPhase) => {
    if (!nextPhase || session.phase === nextPhase) {
      return
    }

    session.phase = nextPhase
    if (session.card) {
      phase = nextPhase
    }

    if (nextPhase === 'partialSource') {
      session.partialSource = true
      counters.partialSourceSent += 1
    } else if (nextPhase === 'sourceEnded') {
      session.sourceEnded = true
      counters.sourceEnded += 1
    } else if (nextPhase === 'complete') {
      session.complete = true
      counters.responsesCompleted += 1
      if (session.card) {
        counters.completed += 1
      }
    } else if (nextPhase === 'interrupted') {
      session.interrupted = true
      counters.responsesInterrupted += 1
      if (session.card) {
        counters.interrupted += 1
      }
    }
  }

  const snapshot = () => ({
    phase,
    activeCount: activeControllers.size,
    counters: { ...counters },
    starts: counters.cardStarts,
    completed: counters.completed,
    followups: counters.followups,
    sessions: [...sessions.values()].map(session => ({ ...session }))
  })

  const reset = () => {
    for (const value of Object.keys(counters)) {
      counters[value] = 0
    }
    sessions.clear()
    phase = 'idle'
    nextRequest = 1
  }

  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', `http://${host}`).pathname

    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }

    if (request.method === 'GET' && pathname === '/fixture-state') {
      sendJson(response, 200, snapshot())
      return
    }

    if (request.method === 'POST' && pathname === '/fixture-state/reset') {
      reset()
      sendJson(response, 200, snapshot())
      return
    }

    if (request.method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
      sendJson(response, 200, { object: 'list', data: [model] })
      return
    }

    if (request.method === 'GET' && pathname === '/health') {
      sendJson(response, 200, { ok: true, model: model.id, phase })
      return
    }

    if (
      request.method !== 'POST' ||
      (pathname !== '/v1/chat/completions' && pathname !== '/chat/completions')
    ) {
      sendJson(response, 404, { error: { message: 'fixture route not found' } })
      return
    }

    let body
    try {
      body = await readJson(request)
    } catch (error) {
      sendJson(response, 400, {
        error: { message: error instanceof Error ? error.message : 'invalid request body' }
      })
      return
    }

    counters.requests += 1
    const requestNumber = nextRequest
    nextRequest += 1
    const streamId = `fixture-request-${requestNumber}`
    const cardId = `fixture-card-${requestNumber}`
    const { kind, prompt } = classifyFixturePrompt(body)
    const session = {
      id: streamId,
      kind,
      card: kind === 'primary' || kind === 'secondary',
      prompt,
      phase: 'streaming',
      chunksSent: 0,
      partialSource: false,
      sourceEnded: false,
      complete: false,
      interrupted: false
    }
    sessions.set(streamId, session)
    if (session.card) {
      phase = 'streaming'
    }

    if (kind === 'primary') {
      counters.cardStarts += 1
    } else if (kind === 'secondary') {
      counters.cardStarts += 1
      counters.secondSessionStarts += 1
    } else if (kind === 'followup') {
      counters.followups += 1
    }

    const generated = kind === 'primary'
      ? createFixtureResponse({ id: cardId, program: primaryProgram })
      : kind === 'secondary'
        ? createFixtureResponse({ id: cardId, program: secondaryProgram })
        : null

    if (!generated) {
      const text = kind === 'followup'
        ? 'Follow-up received in this conversation.'
        : 'Stream fixture received the prompt.'

      if (!body.stream) {
        updatePhase(session, 'complete')
        sendJson(response, 200, {
          id: streamId,
          object: 'chat.completion',
          created: 0,
          model: model.id,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: 'stop'
          }]
        })
        return
      }

      counters.streams += 1
      response.writeHead(200, {
        'cache-control': 'no-cache',
        'content-type': 'text/event-stream',
        connection: 'keep-alive'
      })
      response.flushHeaders()
      sendSse(response, event(streamId, text))
      sendSse(response, event(streamId, undefined, 'stop'))
      sendSse(response, '[DONE]')
      updatePhase(session, 'complete')
      response.end()
      return
    }

    if (!body.stream) {
      updatePhase(session, 'complete')
      sendJson(response, 200, {
        id: streamId,
        object: 'chat.completion',
        created: 0,
        model: model.id,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: generated.text },
          finish_reason: 'stop'
        }]
      })
      return
    }

    counters.streams += 1
    const controller = new AbortController()
    activeControllers.set(session.id, controller)
    let finished = false
    const interrupt = () => {
      if (finished || session.interrupted) {
        return
      }

      finished = true
      activeControllers.delete(session.id)
      controller.abort()
      if (!response.destroyed && !response.writableEnded) {
        response.destroy()
      }
      updatePhase(session, 'interrupted')
    }
    response.once('close', interrupt)

    response.writeHead(200, {
      'cache-control': 'no-cache',
      'content-type': 'text/event-stream',
      connection: 'keep-alive'
    })
    response.flushHeaders()

    for (const chunk of generated.chunks) {
      if (!sendSse(response, event(streamId, chunk.text))) {
        interrupt()
        return
      }

      session.chunksSent += 1
      updatePhase(session, chunk.phase)

      const pauseMs = chunk.phase === 'partialSource'
        ? halfwayPauseMs
        : chunk.phase === 'sourceEnded'
          ? endDelayMs
          : chunkDelayMs

      if (!await wait(pauseMs, controller.signal)) {
        interrupt()
        return
      }
    }

    if (!sendSse(response, event(streamId, undefined, 'stop'))) {
      interrupt()
      return
    }
    if (body.stream_options?.include_usage) {
      sendSse(response, usageEvent(streamId, generated.text))
    }
    sendSse(response, '[DONE]')

    finished = true
    activeControllers.delete(session.id)
    updatePhase(session, 'complete')
    response.end()
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : port

  return Object.freeze({
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}/v1`,
    server,
    state: snapshot,
    reset,
    close: async () => {
      for (const controller of activeControllers.values()) {
        controller.abort()
      }
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
      })
    }
  })
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  const fixture = await startModelFixture()
  console.log(`OpenUI model fixture listening on ${fixture.url}`)

  let closing = false
  const shutdown = async () => {
    if (closing) {
      return
    }

    closing = true
    await fixture.close()
  }

  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())
}
