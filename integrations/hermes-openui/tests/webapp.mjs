import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright-core'
import { DESIGN_OPENUI_PROGRAM } from '../src/library.tsx'
import {
  PRIMARY_PROMPT,
  QUERY_PROMPT,
  SECOND_SESSION_PROMPT,
  startModelFixture
} from './model-fixture.mjs'

async function startQueryFixture(port) {
  const requests = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
    requests.push({
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams)
    })
    if (request.method !== 'GET' || url.pathname !== '/rows') {
      response.writeHead(404, {'content-type':'application/json'})
      response.end(JSON.stringify({error:'not found'}))
      return
    }
    response.writeHead(200, {
      'cache-control':'no-store',
      'content-type':'application/json'
    })
    response.end(JSON.stringify({
      rows: [{id:'ORD-1042', region:'North', amount:42}]
    }))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return {
    requests,
    url: `http://127.0.0.1:${port}/rows`,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    })
  }
}

const hermes = process.env.OPENUI_TEST_HERMES
assert.ok(hermes, 'Set OPENUI_TEST_HERMES to the isolated Hermes executable')
let output
try {
  output = execFileSync(hermes, ['webapp', '--skip-build', '--no-open'], {
    encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe']
  })
} catch {
  throw new Error('Could not get a sign-in link from the isolated Hermes Webapp')
}
const url = output.match(/https?:\/\/[^\s]+/)?.[0]
const webappPort = process.env.OPENUI_TEST_WEBAPP_PORT ?? '19120'
assert.ok(url && new URL(url).port === webappPort, 'Expected a sign-in link for the isolated Webapp')
const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', args:['--no-sandbox']})
const primaryHeading = DESIGN_OPENUI_PROGRAM.match(/Title\("([^"\n]+)"/)?.[1]
assert.ok(primaryHeading, 'The primary fixture must contain a page title')
const fixture = await startModelFixture({ primaryProgram: DESIGN_OPENUI_PROGRAM, secondaryProgram: DESIGN_OPENUI_PROGRAM.replace(primaryHeading, 'Second session comparison') }).catch(async error => {
  await browser.close()
  throw error
})
const queryFixture = await startQueryFixture(
  Number(process.env.OPENUI_QUERY_FIXTURE_PORT ?? '19124')
)
const page = await browser.newPage({viewport:{width:1360,height:900}})
await page.addInitScript(() => {
  globalThis.localStorage.setItem('hermes.desktop.pluginDecisions.v2', '{"hermes-openui":true}')
})
const diagnostics = []
page.on('pageerror', error => diagnostics.push(error.message))
page.on('console', msg => { if (msg.type() === 'error') diagnostics.push(msg.text()) })
page.setDefaultTimeout(15_000)
const fixturePort = process.env.OPENUI_FIXTURE_PORT ?? '19121'
const state = () => fetch(`http://127.0.0.1:${fixturePort}/fixture-state`).then(r=>r.json())
async function waitForState(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  let snapshot = await state()
  while (!predicate(snapshot) && Date.now() < deadline) {
    await delay(100)
    snapshot = await state()
  }
  return snapshot
}
const composer = page.locator('[data-slot="composer-rich-input"]').filter({visible:true}).first()
const runTag = randomUUID()
const primaryPrompt = `${PRIMARY_PROMPT} [run ${runTag}]`
const secondaryPrompt = `${SECOND_SESSION_PROMPT} [run ${runTag}]`
const evidence = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  status: 'running',
  continuity: null,
  checks: {},
  counters: {},
  diagnostics: []
}
const sanitize = value => String(value).replace(/https?:\/\/[^\s]+/g, '[URL]')
const record = (name, details = {}) => {
  evidence.checks[name] = { passed: true, ...details }
}
const saveEvidence = async error => {
  evidence.finishedAt = new Date().toISOString()
  evidence.diagnostics = diagnostics.slice(-8).map(sanitize)
  if (error) {
    evidence.error = sanitize(error instanceof Error ? error.message : error)
  }
  await mkdir('evidence',{recursive:true})
  await writeFile('evidence/webapp-results.json', `${JSON.stringify(evidence,null,2)}\n`)
}
async function send(prompt) {
  await page.getByText('Waking up …',{exact:true}).waitFor({state:'hidden',timeout:20_000})
  await composer.click()
  await composer.pressSequentially(prompt)
  await composer.press('Enter')
}
try {
  await mkdir('evidence',{recursive:true})
  execFileSync(hermes, [
    'config',
    'set',
    'plugins.entries.hermes-openui.settings.query_url',
    queryFixture.url
  ], {stdio:'ignore'})
  await page.goto(url, {waitUntil:'domcontentloaded'})
  record('webapp-loaded')
  await send(primaryPrompt)
  const card = page.locator('[data-hermes-openui-card].hermes-openui-card-mount').first()
  await page.getByRole('heading',{name:primaryHeading}).waitFor({timeout:25_000})
  const earlyState = await state()
  const earlySession = earlyState.sessions.find(session => session.prompt === primaryPrompt)
  assert.ok(earlySession,'The primary fixture session must start')
  assert.equal(earlySession.sourceEnded,false,'Opening card must appear before the source closes')
  await card.evaluate((el, expectedHeading) => {
    globalThis.__hermesOpenUiEarlyCard = el
    const frames = { count: 0, withoutHeading: 0 }
    globalThis.__hermesOpenUiFrames = frames
    function sample() {
      if (globalThis.__hermesOpenUiFrames !== frames) return
      const heading = [...globalThis.document.querySelectorAll(
        '.hermes-openui-card-mount [role="heading"]'
      )].find(element => element.textContent === expectedHeading)
      frames.count++
      if (!heading?.getClientRects().length) frames.withoutHeading++
      globalThis.requestAnimationFrame(sample)
    }
    globalThis.requestAnimationFrame(sample)
  }, primaryHeading)
  record('early-card-render', {sourceEnded: earlySession.sourceEnded})
  await page.screenshot({path:'evidence/streaming.png'})
  await page.getByText('The full reply is finished.').waitFor()
  const slider = page.getByRole('slider', {name:'Evidence floor'}).first()
  await page.waitForFunction(() => {
    const input = globalThis.document.querySelector('[data-hermes-openui-card] input[type="range"]')
    return input && !input.disabled
  })
  const continuityCheck = await page.evaluate(() => {
    const early = globalThis.__hermesOpenUiEarlyCard
    const current = globalThis.document.querySelector('[data-hermes-openui-card].hermes-openui-card-mount')
    const frames = globalThis.__hermesOpenUiFrames
    globalThis.__hermesOpenUiFrames = null
    return {
      sameNode: Boolean(early && current === early),
      earlyConnected: Boolean(early?.isConnected),
      currentFound: Boolean(current),
      ...frames
    }
  })
  evidence.continuity = continuityCheck.sameNode
  const completedState = await state()
  evidence.counters.afterSourceEnded = completedState.counters
  assert.ok(
    completedState.sessions.some(session => session.prompt === primaryPrompt && session.sourceEnded),
    'The primary fixture session must finish its source'
  )
  const followupsBeforeControls = completedState.counters.followups
  const targetedFollowupsBefore = completedState.sessions.filter(
    session => session.kind === 'followup' && session.prompt.includes('Speed comparison above 90%')
  ).length
  record('source-completed', continuityCheck)
  await slider.waitFor()
  assert.equal(await page.locator('[data-hermes-openui-card].hermes-openui-card-mount').count(),1)
  assert.equal(await page.getByText(/openui:source|root = Col\(/).count(),0,'Raw DSL must not leak')
  await page.getByRole('radio',{name:'Speed'}).click()
  await page.locator('.iui-chart svg[aria-label*="Speed"]').waitFor()
  await slider.fill('90')
  await page.getByText('Showing Speed scores; 90% is the evidence floor.',{exact:true}).waitFor()
  const afterControls = await state()
  assert.equal(afterControls.counters.followups,followupsBeforeControls,'Controls must react locally')
  await page.screenshot({path:'evidence/interactive.png',animations:'disabled'})
  record('local-controls', {followups:0, lens:'Speed', evidenceFloor:'90%'})
  await page.reload({waitUntil:'domcontentloaded'})
  await page.locator('.iui-chart svg[aria-label*="Speed"]').waitFor()
  assert.equal(await slider.inputValue(),'90')
  record('reload-persistence', {evidenceFloor:await slider.inputValue(), lens:'Speed'})
  await page.getByRole('button', {name:'Explain this trade-off'}).click()
  await page.getByText('Follow-up received in this conversation.').waitFor()
  const afterFollowup = await state()
  const targetedFollowupsAfter = afterFollowup.sessions.filter(
    session => session.kind === 'followup' && session.prompt.includes('Speed comparison above 90%')
  ).length
  assert.ok(afterFollowup.followups > followupsBeforeControls,'Follow-up must reach the fixture')
  assert.ok(targetedFollowupsAfter > targetedFollowupsBefore,'Follow-up must use the targeted prompt')
  evidence.counters.afterFollowup = afterFollowup.counters
  record('targeted-follow-up', {
    followupsBefore:followupsBeforeControls,
    followupsAfter:afterFollowup.followups,
    targetedBefore:targetedFollowupsBefore,
    targetedAfter:targetedFollowupsAfter
  })

  const newSessionButtons = page.getByRole('button',{name:'New session',exact:true}).filter({visible:true})
  await newSessionButtons.first().waitFor()
  const visibleNewSessionButtons = await newSessionButtons.count()
  assert.ok(visibleNewSessionButtons > 0,'Expected a visible New session button')
  await newSessionButtons.first().click()
  await page.getByText(/untitled session/i).first().waitFor()
  record('new-session-button', {visibleButtons:visibleNewSessionButtons})
  await send(secondaryPrompt)
  await page.getByRole('heading',{name:'Second session comparison'}).waitFor({timeout:25_000})
  const secondStarted = await state()
  evidence.counters.afterSecondPrompt = secondStarted.counters
  const ownSecondarySessions = secondStarted.sessions.filter(
    session => session.kind === 'secondary' && session.prompt === secondaryPrompt
  )
  record('second-session-submitted', {fixtureSessions:ownSecondarySessions.length})
  assert.ok(ownSecondarySessions.length > 0,'Second prompt must reach a secondary fixture session')
  assert.equal(await page.getByRole('heading',{name:primaryHeading}).count(),0)
  const stopButtons = page.locator('[data-slot="composer-root"] button[aria-label="Stop"]').filter({visible:true})
  await stopButtons.first().waitFor()
  assert.equal(await stopButtons.count(),1,'Expected one visible Stop button while the second response streams')
  await stopButtons.click()
  await page.getByText('Interactive card unavailable.',{exact:true}).waitFor()
  assert.equal(await page.getByRole('heading',{name:'Second session comparison'}).count(),0)
  const stopped=await waitForState(snapshot => snapshot.sessions.some(
    session => session.kind === 'secondary' &&
      session.prompt === secondaryPrompt &&
      session.interrupted
  ))
  const stoppedSecondarySessions = stopped.sessions.filter(
    session => session.kind === 'secondary' && session.prompt === secondaryPrompt
  )
  assert.ok(
    stoppedSecondarySessions.some(session => session.interrupted),
    'Stop must interrupt a run-specific secondary fixture session'
  )
  evidence.counters.afterInterruption = stopped.counters
  record('new-session-isolation-and-stop', {
    fixtureSessions:stoppedSecondarySessions.length,
    interruptedSessions:stoppedSecondarySessions.filter(session => session.interrupted).length
  })
  const firstSessionTab = page.getByRole('tab',{name:/here is the interactive view/i}).first()
  const secondSessionTab = page.getByRole('tab',{name:/please make the second openui example/i}).first()
  await firstSessionTab.waitFor()
  await secondSessionTab.waitFor()
  await firstSessionTab.click()
  await page.getByRole('heading',{name:primaryHeading}).waitFor()
  assert.equal(await slider.inputValue(),'90')
  record('return-to-first-session', {evidenceFloor:await slider.inputValue()})
  await page.getByRole('button',{name:'New session',exact:true}).filter({visible:true}).first().click()
  await page.getByText(/untitled session/i).first().waitFor()
  await send(QUERY_PROMPT)
  await page.getByRole('heading',{name:'Configured query'}).waitFor({timeout:25_000})
  await page.getByText('ORD-1042',{exact:true}).waitFor()
  await page.getByText('North',{exact:true}).waitFor()
  const queryRequests = queryFixture.requests.filter(
    request => request.method === 'GET' && request.path === '/rows'
  )
  assert.ok(queryRequests.length > 0,'The browser Query bridge must reach the configured source')
  assert.equal(queryRequests.at(-1)?.query.window,'30d')
  const afterQuery = await state()
  assert.ok(afterQuery.counters.queryStarts > 0,'The fixture must emit a Query card')
  record('configured-query', {
    requests:queryRequests.length,
    window:queryRequests.at(-1)?.query.window
  })
  assert.ok(continuityCheck.count > 0, 'The browser must sample the card while streaming')
  assert.equal(continuityCheck.withoutHeading, 0, 'The heading must remain visible through completion')
  evidence.status = 'passed'
  await saveEvidence()
  console.log('Hermes Webapp + fixture verified: continuous visible card, local controls, reload, targeted action, session switch and interruption.', continuityCheck)
} catch (error) {
  evidence.status = 'failed'
  await saveEvidence(error)
  console.log('Webapp diagnostics:',diagnostics.slice(-8).map(s=>s.replace(/https?:\/\/[^\s]+/g,'[URL]')))
  console.log('Visible UI excerpt:',sanitize((await page.locator('body').innerText().catch(()=> '')).slice(-1800)))
  console.log('Continuity:',evidence.continuity)
  console.log('Completed checks:',Object.keys(evidence.checks))
  await page.screenshot({path:'evidence/failed.png'}).catch(()=>{})
  throw error
} finally {
  await browser.close()
  await fixture.close()
  await queryFixture.close()
}
