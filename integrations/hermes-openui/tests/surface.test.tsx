import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createParser } from '@openuidev/react-lang'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  DECISION_BRIEF_OPENUI_PROGRAM,
  DESIGN_OPENUI_PROGRAM,
  openUILibrary,
  PHOTO_STRIP_OPENUI_PROGRAM,
  SAMPLE_OPENUI_PROGRAM
} from '../src/library.tsx'
import { OpenUISurface } from '../src/surface.tsx'

const FIRST_DESIGN_FRAME = `root = Card("Choose a retrieval strategy", "Hybrid is the safer default for mixed exact-match and semantic queries.", [kpis, tabs, chart, insight, checkpoint, note])`
const LOCAL_PHOTO_FIXTURES = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800"><title>Local browser fixture one</title><rect width="1200" height="800" fill="#f6b26b"/><circle cx="930" cy="180" r="110" fill="#fff3cf"/><path d="M0 620 360 350 720 610 980 410 1200 590V800H0Z" fill="#9c4f2e"/></svg>`,
  `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800"><title>Local browser fixture two</title><rect width="1200" height="800" fill="#9fd8e8"/><path d="M0 560Q300 430 600 560T1200 520V800H0Z" fill="#355f78"/><circle cx="260" cy="210" r="95" fill="#eef8fb"/></svg>`,
  `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800"><title>Local browser fixture three</title><rect width="1200" height="800" fill="#b7c5ca"/><path d="M0 650 280 390 520 620 790 310 1200 650V800H0Z" fill="#51636c"/><rect x="520" y="80" width="160" height="220" rx="22" fill="#f5eee2"/></svg>`
]

type HarnessWindow = Window & {
  __openUICalls: Array<[string, string]>
  __setOpenUI: (source: string, streaming: boolean) => void
  __setOpenUISession: (sessionId: null | string) => void
}

test('published programs satisfy the OpenUI library schema', () => {
  const parser = createParser(openUILibrary.toJSONSchema(), openUILibrary.root)
  const decisionBrief = parser.parse(DECISION_BRIEF_OPENUI_PROGRAM)
  const design = parser.parse(DESIGN_OPENUI_PROGRAM)
  const photoStrip = parser.parse(PHOTO_STRIP_OPENUI_PROGRAM)
  const slider = parser.parse(SAMPLE_OPENUI_PROGRAM)

  assert.equal(decisionBrief.root?.typeName, 'Card')
  assert.deepEqual(decisionBrief.meta.errors, [])
  assert.deepEqual(decisionBrief.meta.unresolved, [])
  assert.equal(decisionBrief.stateDeclarations.$view, 'Decision')
  assert.equal(design.root?.typeName, 'Card')
  assert.deepEqual(design.meta.errors, [])
  assert.deepEqual(design.meta.unresolved, [])
  assert.equal(design.stateDeclarations.$lens, 'Quality')
  assert.equal(design.stateDeclarations.$minimum, 75)
  assert.doesNotMatch(DESIGN_OPENUI_PROGRAM, /fixture|demo|design surface/i)
  assert.equal(photoStrip.root?.typeName, 'Card')
  assert.deepEqual(photoStrip.meta.errors, [])
  assert.deepEqual(photoStrip.meta.unresolved, [])
  assert.equal(slider.root?.typeName, 'Card')
  assert.deepEqual(slider.meta.errors, [])
  assert.deepEqual(slider.meta.unresolved, [])
})

test('the skill sample matches the runtime library', async () => {
  const skill = await readFile('skills/openui/SKILL.md', 'utf8')
  const source = skill.match(
    /<!--openui:source id="ui-decision-01"\n([\s\S]*?)\nopenui:end-->/
  )?.[1]
  const parser = createParser(openUILibrary.toJSONSchema(), openUILibrary.root)
  const result = parser.parse(source ?? '')

  assert.ok(source)
  assert.equal(source, DECISION_BRIEF_OPENUI_PROGRAM)
  assert.equal(result.root?.typeName, 'Card')
  assert.deepEqual(result.meta.errors, [])
  assert.deepEqual(result.meta.unresolved, [])
  assert.equal(result.stateDeclarations.$view, 'Decision')
})

test('the original slider fixture still renders through the real Renderer', () => {
  const html = renderToStaticMarkup(
    <OpenUISurface
      identity="filter-card-a"
      onFollowUp={() => true}
      sessionId="session-a"
      source={SAMPLE_OPENUI_PROGRAM}
      streaming={false}
    />
  )

  assert.match(html, /Filter results/)
  assert.match(html, /Minimum relevance/)
  assert.match(html, /data-hermes-openui-range/)
  assert.match(html, /Explain these results/)
  assert.match(html, /--oui-chart-1/)
})

test('the cited decision brief renders safe external source links', () => {
  const html = renderToStaticMarkup(
    <OpenUISurface
      identity="decision-card-a"
      onFollowUp={() => true}
      sessionId="session-a"
      source={DECISION_BRIEF_OPENUI_PROGRAM}
      streaming={false}
    />
  )

  assert.match(html, /Choose a retrieval path/)
  assert.match(html, /data-hermes-openui-citations/)
  assert.match(html, /href="https:\/\/arxiv.org\/abs\/2004.04906"/)
  assert.match(html, /target="_blank"/)
  assert.match(html, /rel="noopener noreferrer"/)
  assert.match(html, /Draft an evaluation plan/)
})

test('citation links reject unsupported protocols', () => {
  const unsafeProgram = DECISION_BRIEF_OPENUI_PROGRAM.replace(
    'https://doi.org/10.1561/1500000019',
    'javascript:alert(1)'
  )
  const html = renderToStaticMarkup(
    <OpenUISurface
      identity="unsafe-citation-card"
      onFollowUp={() => true}
      sessionId="session-a"
      source={unsafeProgram}
      streaming={false}
    />
  )

  assert.doesNotMatch(html, /href="javascript:/)
  assert.match(html, /data-safe-url="false"/)
})

test('the photo strip renders honest source links and rejects unsafe media URLs', () => {
  const html = renderToStaticMarkup(
    <OpenUISurface
      identity="photo-strip-card"
      onFollowUp={() => true}
      sessionId="session-a"
      source={PHOTO_STRIP_OPENUI_PROGRAM}
      streaming={false}
    />
  )

  assert.match(html, /Three views of San Francisco/)
  assert.equal((html.match(/data-hermes-openui-photo="true"/g) ?? []).length, 3)
  assert.match(html, /src="https:\/\/upload.wikimedia.org\//)
  assert.match(html, /Brocken Inaglory/)
  assert.match(html, /CC BY-SA 3.0/)
  assert.match(html, /href="https:\/\/commons.wikimedia.org\/wiki\/File:/)
  assert.match(html, /target="_blank"/)
  assert.match(html, /rel="noopener noreferrer"/)
  assert.match(html, /https:\/\/www.openstreetmap.org\/export\/embed.html/)
  assert.match(html, /href="https:\/\/www.openstreetmap.org\/relation\/21407754"/)

  const unsafeProgram = PHOTO_STRIP_OPENUI_PROGRAM.replace(
    'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d3/Golden_Gate_Bridge_at_sunset_1.jpg/1280px-Golden_Gate_Bridge_at_sunset_1.jpg',
    'http://example.com/not-secure.jpg'
  )
  const unsafeHtml = renderToStaticMarkup(
    <OpenUISurface
      identity="unsafe-photo-strip-card"
      onFollowUp={() => true}
      sessionId="session-a"
      source={unsafeProgram}
      streaming={false}
    />
  )

  assert.doesNotMatch(unsafeHtml, /src="http:\/\//)
  assert.match(unsafeHtml, /data-photo-state="fallback"/)
  assert.match(unsafeHtml, /Image unavailable/)
})

test('PlaceMap rejects invalid coordinates and keeps the OpenStreetMap fallback link', () => {
  const invalidProgram = PHOTO_STRIP_OPENUI_PROGRAM.replace(
    'lat: 37.8182923',
    'lat: 95'
  )
  const html = renderToStaticMarkup(
    <OpenUISurface
      identity="invalid-place-map"
      onFollowUp={() => true}
      sessionId="session-a"
      source={invalidProgram}
      streaming={false}
    />
  )

  assert.doesNotMatch(html, /openstreetmap.org\/export\/embed.html/)
  assert.match(html, /Map unavailable for this place/)
  assert.match(html, /href="https:\/\/www.openstreetmap.org\/relation\/21407754"/)
  assert.match(html, /Map data © OpenStreetMap contributors/)
})

test(
  'the Renderer keeps its root through prefix variants, completion, and session aliases',
  { timeout: 60_000 },
  async t => {
    const workspace = process.cwd()
    const surfacePath = path.join(workspace, 'src/surface.tsx')
    const firstFrameSource = JSON.stringify(FIRST_DESIGN_FRAME)
    const completeFrame = { source: DESIGN_OPENUI_PROGRAM, streaming: false }
    const growingFrame = { ...completeFrame, streaming: true }
    const harness = `
      import { useEffect, useState } from 'react'
      import { createRoot } from 'react-dom/client'
      import { OpenUISurface } from ${JSON.stringify(surfacePath)}

      declare global {
        interface Window {
          __openUICalls: Array<[string, string]>
          __setOpenUI: (source: string, streaming: boolean) => void
          __setOpenUISession: (sessionId: string | null) => void
        }
      }

      const initialSource = ${firstFrameSource}

      function Harness() {
        const [source, setSource] = useState(initialSource)
        const [streaming, setStreaming] = useState(true)
        const [sessionId, setSessionId] = useState<string | null>('session-a')

        useEffect(() => {
          window.__setOpenUI = (nextSource, nextStreaming) => {
            setStreaming(nextStreaming)
            setSource(nextSource)
          }
          window.__setOpenUISession = setSessionId
        }, [])

        return (
          <OpenUISurface
            identity="research-card-a"
            onFollowUp={(message, destination) => {
              window.__openUICalls.push([destination, message])
              return true
            }}
            sessionId={sessionId}
            source={source}
            streaming={streaming}
          />
        )
      }

      window.__openUICalls = []
      createRoot(document.getElementById('root')!).render(<Harness />)
    `
    const temp = await mkdtemp(path.join(tmpdir(), 'hermes-openui-test-'))
    const harnessPath = path.join(temp, 'harness.tsx')
    await writeFile(harnessPath, harness)
    const bundled = await build({
      absWorkingDir: workspace,
      bundle: true,
      define: { 'process.env.NODE_ENV': '"production"' },
      entryPoints: [harnessPath],
      format: 'iife',
      jsx: 'automatic',
      nodePaths: [path.join(workspace, 'node_modules')],
      platform: 'browser',
      write: false
    })
    const html = `<!doctype html><html><head><style>
      :root {
        --font-sans: "Inter", ui-sans-serif, sans-serif;
        --ui-control-hover-background: #f1f1f1;
        --ui-stroke-secondary: #dedede;
        --ui-text-primary: #0d0d0d;
        --ui-text-secondary: #666;
        --ui-widget-surface-background: #fff;
      }
      * { box-sizing: border-box; }
      body { margin: 0; padding: 28px; background: #f7f7f8; }
      #root { margin: 0 auto; max-width: 760px; }
    </style></head><body><div id="root"></div><script>${bundled.outputFiles[0].text}</script></body></html>`
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()

    assert.ok(address && typeof address === 'object')

    const browser = await chromium.launch({
      args: ['--no-sandbox'],
      executablePath: '/usr/bin/chromium',
      headless: true
    })
    t.after(async () => {
      await browser.close()
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()))
      })
      await rm(temp, { force: true, recursive: true })
    })
    const page = await browser.newPage({ viewport: { height: 900, width: 900 } })
    const pageErrors: string[] = []

    page.setDefaultTimeout(5_000)
    page.on('console', message => console.error(`[browser:${message.type()}] ${message.text()}`))
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.goto(`http://127.0.0.1:${address.port}`)
    await page.waitForFunction(
      () => typeof (window as unknown as HarnessWindow).__setOpenUI === 'function'
    )

    const card = page.locator('[data-hermes-openui-card]')
    const range = page.locator('[data-hermes-openui-range]')
    const followUp = page.getByRole('button', { name: 'Explain this trade-off' })

    await card.waitFor()
    await card.locator('.hermes-openui-title').filter({ hasText: 'Choose a retrieval strategy' }).waitFor()
    assert.equal(await range.count(), 0)
    await card.evaluate(element => element.setAttribute('data-before-complete', 'true'))

    await page.evaluate(
      frame => (window as unknown as HarnessWindow).__setOpenUI(frame.source, frame.streaming),
      growingFrame
    )
    await page.locator('[data-hermes-openui-chart]').waitFor()
    await page.locator('[data-hermes-openui-segmented]').waitFor()
    assert.equal(
      await page.locator('[data-hermes-openui-chart]').getAttribute('data-hermes-openui-lens'),
      'Quality'
    )
    assert.equal(await range.inputValue(), '75')
    assert.equal(await range.isDisabled(), true)
    assert.equal(await followUp.isDisabled(), true)
    assert.equal(await card.getAttribute('data-before-complete'), 'true')

    await page.evaluate(
      frame => (window as unknown as HarnessWindow).__setOpenUI(frame.source, frame.streaming),
      completeFrame
    )
    await page.waitForFunction(
      () => !(document.querySelector('[data-hermes-openui-range]') as HTMLInputElement | null)?.disabled
    )
    assert.equal(await card.getAttribute('data-before-complete'), 'true')

    await page.getByRole('radio', { name: 'Speed' }).click()
    await page.locator('[data-hermes-openui-chart][data-hermes-openui-lens="Speed"]').waitFor()
    await page.locator('[data-hermes-openui-bar="Graph"]').filter({ hasText: '90' }).waitFor()
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[data-hermes-openui-bar]')].every(row => {
        const track = row.querySelector('.hermes-openui-bar-track')
        const fill = row.querySelector('.hermes-openui-bar-fill')
        const expected = Number(row.querySelector('.hermes-openui-bar-value')?.textContent)

        if (!(track instanceof HTMLElement) || !(fill instanceof HTMLElement)) {
          return false
        }

        const actual = (fill.getBoundingClientRect().width / track.getBoundingClientRect().width) * 100
        return Math.abs(actual - expected) < 0.5
      })
    )

    await range.focus()
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowRight')
    await range.fill('90')
    await page.locator('[data-hermes-openui-output]').filter({ hasText: '90%' }).waitFor()
    await page
      .locator('[data-hermes-openui-chart] .hermes-openui-benchmark-meta')
      .filter({ hasText: '2 bars below 90%' })
      .waitFor()
    assert.equal(
      await page.locator('[data-hermes-openui-bar][data-hermes-openui-below="true"]').count(),
      2
    )
    const focusStyles = await range.evaluate(element => {
      const input = getComputedStyle(element)

      return {
        focusVisible: element.matches(':focus-visible'),
        outlineStyle: input.outlineStyle
      }
    })

    assert.equal(focusStyles.focusVisible, true)
    assert.equal(focusStyles.outlineStyle, 'none')
    await page.waitForFunction(() => {
      const value = Object.values(localStorage).join(' ')
      return value.includes('Speed') && value.includes('90')
    })

    const screenshotPath = process.env.HERMES_OPENUI_SCREENSHOT

    if (screenshotPath) {
      await page.waitForTimeout(250)
      await page.screenshot({ fullPage: true, path: screenshotPath })
    }

    const darkScreenshotPath = process.env.HERMES_OPENUI_DARK_SCREENSHOT

    await page.evaluate(() => document.documentElement.classList.add('dark'))
    assert.equal(
      await page
        .locator('[data-hermes-openui-surface]')
        .evaluate(element => getComputedStyle(element).getPropertyValue('--oui-canvas').trim()),
      '#1c1c1e'
    )

    if (darkScreenshotPath) {
      await page.evaluate(() => {
        document.body.style.background = '#171717'
      })
      await page.waitForTimeout(250)
      await page.screenshot({ fullPage: true, path: darkScreenshotPath })
    }

    await page.reload()
    await page.waitForFunction(
      () => typeof (window as unknown as HarnessWindow).__setOpenUI === 'function'
    )
    await page.evaluate(
      frame => (window as unknown as HarnessWindow).__setOpenUI(frame.source, frame.streaming),
      completeFrame
    )
    await page.locator('[data-hermes-openui-chart][data-hermes-openui-lens="Speed"]').waitFor()
    assert.equal(await range.inputValue(), '90')
    await page.locator('[data-hermes-openui-output]').filter({ hasText: '90%' }).waitFor()

    await page.getByRole('radio', { name: 'Speed' }).click()
    await page.waitForFunction(() =>
      document.querySelector('[data-hermes-openui-chart]')?.getAttribute('data-hermes-openui-lens') === 'Speed'
    )
    await page.evaluate(() => {
      document
        .querySelector('[data-hermes-openui-surface]')
        ?.setAttribute('data-surface-before-prefix', 'true')
      document
        .querySelector('[data-hermes-openui-card]')
        ?.setAttribute('data-card-before-prefix', 'true')
    })
    await page.evaluate(
      frame => (window as unknown as HarnessWindow).__setOpenUI(
        'root = Card("Choose a retrieval strategy", "Hybrid is the safer default for mixed exact-match and semantic queries.", [])',
        frame.streaming
      ),
      growingFrame
    )
    await page.locator('.hermes-openui-title').filter({ hasText: 'Choose a retrieval strategy' }).waitFor()
    assert.equal(
      await page.locator('[data-hermes-openui-surface]').getAttribute('data-surface-before-prefix'),
      'true'
    )
    assert.equal(
      await page.locator('[data-hermes-openui-card]').getAttribute('data-card-before-prefix'),
      'true'
    )
    await page.evaluate(
      frame => (window as unknown as HarnessWindow).__setOpenUI(frame.source, frame.streaming),
      completeFrame
    )
    assert.equal(
      await page.locator('[data-hermes-openui-surface]').getAttribute('data-surface-before-prefix'),
      'true'
    )
    assert.equal(
      await page.locator('[data-hermes-openui-card]').getAttribute('data-card-before-prefix'),
      'true'
    )

    await page.evaluate(() => {
      document
        .querySelector('[data-hermes-openui-card]')
        ?.setAttribute('data-card-before-final', 'true')
    })
    await page.evaluate(() => (window as unknown as HarnessWindow).__setOpenUISession('session-b'))
    await page.waitForFunction(
      () => document.querySelector('[data-hermes-openui-surface]')?.getAttribute('data-hermes-openui-identity') === 'research-card-a'
    )
    assert.equal(
      await page.locator('[data-hermes-openui-card]').getAttribute('data-card-before-final'),
      'true'
    )
    assert.equal(await page.getByRole('radio', { name: 'Speed' }).getAttribute('aria-checked'), 'true')
    await page.evaluate(() => (window as unknown as HarnessWindow).__setOpenUISession('session-a'))
    await page.waitForFunction(
      () => document.querySelector('[data-hermes-openui-chart]')?.getAttribute('data-hermes-openui-lens') === 'Speed'
    )

    await followUp.click()
    await followUp.click()
    assert.deepEqual(await page.evaluate(() => (window as unknown as HarnessWindow).__openUICalls), [
      ['session-a', 'Explain the Speed comparison above 90% evidence floor.']
    ])

    await page.evaluate(() => (window as unknown as HarnessWindow).__setOpenUISession(null))
    await followUp.click()
    assert.equal(await page.evaluate(() => (window as unknown as HarnessWindow).__openUICalls.length), 1)
    assert.deepEqual(pageErrors, [])
  }
)

test(
  'the cited decision brief changes views and routes an evidence-aware follow-up',
  { timeout: 60_000 },
  async t => {
    const workspace = process.cwd()
    const surfacePath = path.join(workspace, 'src/surface.tsx')
    const harness = `
      import { createRoot } from 'react-dom/client'
      import { OpenUISurface } from ${JSON.stringify(surfacePath)}

      declare global {
        interface Window {
          __openUICalls: Array<[string, string]>
        }
      }

      function Harness() {
        return (
          <OpenUISurface
            identity="decision-brief-a"
            onFollowUp={(message, destination) => {
              window.__openUICalls.push([destination, message])
              return true
            }}
            sessionId="session-brief"
            source={${JSON.stringify(DECISION_BRIEF_OPENUI_PROGRAM)}}
            streaming={false}
          />
        )
      }

      window.__openUICalls = []
      createRoot(document.getElementById('root')!).render(<Harness />)
    `
    const temp = await mkdtemp(path.join(tmpdir(), 'hermes-openui-brief-test-'))
    const harnessPath = path.join(temp, 'harness.tsx')
    await writeFile(harnessPath, harness)
    const bundled = await build({
      absWorkingDir: workspace,
      bundle: true,
      define: { 'process.env.NODE_ENV': '"production"' },
      entryPoints: [harnessPath],
      format: 'iife',
      jsx: 'automatic',
      nodePaths: [path.join(workspace, 'node_modules')],
      platform: 'browser',
      write: false
    })
    const html = `<!doctype html><html><head><style>
      :root {
        --font-sans: "Inter", ui-sans-serif, sans-serif;
        --ui-text-primary: #0d0d0d;
        --ui-text-secondary: #666;
        --ui-widget-surface-background: #fff;
      }
      * { box-sizing: border-box; }
      body { margin: 0; padding: 28px; background: #f7f7f8; }
      #root { margin: 0 auto; max-width: 760px; }
    </style></head><body><div id="root"></div><script>${bundled.outputFiles[0].text}</script></body></html>`
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()

    assert.ok(address && typeof address === 'object')

    const browser = await chromium.launch({
      args: ['--no-sandbox'],
      executablePath: '/usr/bin/chromium',
      headless: true
    })
    t.after(async () => {
      await browser.close()
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()))
      })
      await rm(temp, { force: true, recursive: true })
    })
    const page = await browser.newPage({ viewport: { height: 900, width: 900 } })
    const pageErrors: string[] = []

    page.setDefaultTimeout(5_000)
    page.on('console', message => console.error(`[browser:${message.type()}] ${message.text()}`))
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.goto(`http://127.0.0.1:${address.port}`)
    await page.locator('[data-hermes-openui-card]').waitFor()
    await page.getByText('Choose a retrieval path', { exact: true }).waitFor()
    await page.getByText(/^Start with hybrid retrieval:/).waitFor()

    const links = await page
      .locator('[data-hermes-openui-citations] a')
      .evaluateAll(elements =>
        elements.map(element => ({
          href: (element as HTMLAnchorElement).href,
          rel: element.getAttribute('rel'),
          target: element.getAttribute('target')
        }))
      )

    assert.equal(links.length, 3)
    assert.ok(links.every(link => link.href.startsWith('https://')))
    assert.ok(links.every(link => link.target === '_blank'))
    assert.ok(links.every(link => link.rel === 'noopener noreferrer'))
    assert.equal(
      await page.locator('[data-hermes-openui-citation][data-safe-url="false"]').count(),
      0
    )

    await page.getByRole('radio', { name: 'Evidence' }).click()
    await page.getByText(/^BM25 supplies a lexical baseline/).waitFor()
    await page.waitForFunction(
      () =>
        document.querySelector('[data-hermes-openui-segmented] [aria-checked="true"]')
          ?.textContent === 'Evidence'
    )
    assert.equal(await page.getByText(/^Start with hybrid retrieval:/).isVisible(), false)

    const screenshotPath = process.env.HERMES_OPENUI_BRIEF_SCREENSHOT

    if (screenshotPath) {
      await page.waitForTimeout(250)
      await page.screenshot({ fullPage: true, path: screenshotPath })
    }

    const darkScreenshotPath = process.env.HERMES_OPENUI_BRIEF_DARK_SCREENSHOT

    await page.evaluate(() => document.documentElement.classList.add('dark'))
    assert.equal(
      await page
        .locator('[data-hermes-openui-surface]')
        .evaluate(element => getComputedStyle(element).getPropertyValue('--oui-canvas').trim()),
      '#1c1c1e'
    )

    if (darkScreenshotPath) {
      await page.evaluate(() => {
        document.body.style.background = '#171717'
      })
      await page.waitForTimeout(250)
      await page.screenshot({ fullPage: true, path: darkScreenshotPath })
    }

    await page.getByRole('button', { name: 'Draft an evaluation plan' }).click()
    assert.deepEqual(
      await page.evaluate(
        () => (window as unknown as { __openUICalls: Array<[string, string]> }).__openUICalls
      ),
      [
        [
          'session-brief',
          'Draft an evaluation plan for hybrid retrieval using the Evidence view. Require citations and report recall, identifier accuracy, latency, and ranking quality.'
        ]
      ]
    )
    assert.deepEqual(pageErrors, [])
  }
)

test(
  'PhotoStrip and PlaceMap align media, update one marker, and preserve fallback links',
  { timeout: 60_000 },
  async t => {
    const workspace = process.cwd()
    const surfacePath = path.join(workspace, 'src/surface.tsx')
    const harness = `
      import { createRoot } from 'react-dom/client'
      import { OpenUISurface } from ${JSON.stringify(surfacePath)}

      createRoot(document.getElementById('root')!).render(
        <OpenUISurface
          identity="photo-strip-browser"
          onFollowUp={() => true}
          sessionId="session-photo"
          source={${JSON.stringify(PHOTO_STRIP_OPENUI_PROGRAM)}}
          streaming={false}
        />
      )
    `
    const temp = await mkdtemp(path.join(tmpdir(), 'hermes-openui-photo-test-'))
    const harnessPath = path.join(temp, 'harness.tsx')
    await writeFile(harnessPath, harness)
    const bundled = await build({
      absWorkingDir: workspace,
      bundle: true,
      define: { 'process.env.NODE_ENV': '"production"' },
      entryPoints: [harnessPath],
      format: 'iife',
      jsx: 'automatic',
      nodePaths: [path.join(workspace, 'node_modules')],
      platform: 'browser',
      write: false
    })
    const html = `<!doctype html><html><head><style>
      :root {
        --font-sans: "Inter", ui-sans-serif, sans-serif;
        --ui-text-primary: #0d0d0d;
        --ui-text-secondary: #666;
        --ui-widget-surface-background: #fff;
      }
      * { box-sizing: border-box; }
      body { margin: 0; padding: 28px; background: #f7f7f8; }
      #root { margin: 0 auto; max-width: 760px; }
    </style></head><body><div id="root"></div><script>${bundled.outputFiles[0].text}</script></body></html>`
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()

    assert.ok(address && typeof address === 'object')

    const browser = await chromium.launch({
      args: ['--no-sandbox'],
      executablePath: '/usr/bin/chromium',
      headless: true
    })
    t.after(async () => {
      await browser.close()
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()))
      })
      await rm(temp, { force: true, recursive: true })
    })
    const page = await browser.newPage({ viewport: { height: 900, width: 900 } })
    const pageErrors: string[] = []
    const mapRequests: string[] = []
    const photoRequests: string[] = []

    page.setDefaultTimeout(5_000)
    page.on('console', message => console.error(`[browser:${message.type()}] ${message.text()}`))
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.route('https://www.openstreetmap.org/export/embed.html**', async route => {
      mapRequests.push(route.request().url())
      await route.fulfill({
        body: '<!doctype html><html><body><main data-local-osm-fixture>Local OpenStreetMap iframe fixture</main></body></html>',
        contentType: 'text/html; charset=utf-8',
        status: 200
      })
    })
    await page.route('https://upload.wikimedia.org/**', async route => {
      const fixture = LOCAL_PHOTO_FIXTURES[photoRequests.length % LOCAL_PHOTO_FIXTURES.length]

      assert.ok(fixture)
      photoRequests.push(route.request().url())
      await route.fulfill({
        body: fixture,
        contentType: 'image/svg+xml',
        status: 200
      })
    })
    await page.goto(`http://127.0.0.1:${address.port}`)
    await page.getByText('Three views of San Francisco', { exact: true }).waitFor()
    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll('[data-hermes-openui-photo] img')]
      return (
        images.length === 3 &&
        images.every(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)
      )
    })

    const photos = page.locator('[data-hermes-openui-photo]')
    const sourceLinks = page.locator('.hermes-openui-photo-caption a')

    assert.equal(await photos.count(), 3)
    assert.equal(await sourceLinks.count(), 3)
    assert.deepEqual(photoRequests.length, 3)
    assert.ok(
      (await sourceLinks.evaluateAll(elements =>
        elements.map(element => (element as HTMLAnchorElement).href)
      )).every(href => href.startsWith('https://commons.wikimedia.org/wiki/File:'))
    )
    assert.ok(
      (await sourceLinks.evaluateAll(elements =>
        elements.map(element => [element.getAttribute('target'), element.getAttribute('rel')])
      )).every(([target, rel]) => target === '_blank' && rel === 'noopener noreferrer')
    )

    const map = page.locator('[data-hermes-openui-place-map]')
    const mapFrame = map.locator('iframe')
    const mapSelector = page.getByRole('combobox', { name: 'Choose a place on the map' })

    await mapFrame.waitFor()
    assert.equal(mapRequests.length, 1)

    const initialMapUrl = new URL((await mapFrame.getAttribute('src')) ?? '')
    const marker = (url: URL) => (url.searchParams.get('marker') ?? '').split(',').map(Number)
    const bbox = initialMapUrl.searchParams.get('bbox')?.split(',').map(Number) ?? []
    const [markerLat, markerLon] = marker(initialMapUrl)

    assert.equal(initialMapUrl.origin + initialMapUrl.pathname, 'https://www.openstreetmap.org/export/embed.html')
    assert.equal(initialMapUrl.searchParams.get('layer'), 'mapnik')
    assert.equal(bbox.length, 4)
    assert.ok(bbox[0]! < bbox[2]! && bbox[1]! < bbox[3]!)
    assert.ok(Math.abs((bbox[1]! + bbox[3]!) / 2 - markerLat!) < 0.000001)
    assert.ok(Math.abs((bbox[0]! + bbox[2]!) / 2 - markerLon!) < 0.000001)
    assert.ok(Math.abs(bbox[3]! - bbox[1]! - 0.018) < 0.00001)
    assert.ok(bbox[2]! - bbox[0]! > 0.02 && bbox[2]! - bbox[0]! < 0.05)
    assert.equal(await mapFrame.getAttribute('sandbox'), 'allow-scripts allow-same-origin')
    assert.equal(await map.getAttribute('data-selected-place'), 'Golden Gate Bridge')

    const nextMapRequest = page.waitForRequest(request =>
      request.url().includes('openstreetmap.org/export/embed.html') &&
      request.url().includes('marker=37.802919%2C-122.448403')
    )

    await mapSelector.selectOption({ label: 'Palace of Fine Arts' })
    await nextMapRequest
    await page.waitForFunction(() => {
      const frame = document.querySelector('[data-hermes-openui-place-map] iframe')
      const src = frame?.getAttribute('src')
      return src ? new URL(src).searchParams.get('marker') === '37.802919,-122.448403' : false
    })
    const changedMapUrl = new URL((await mapFrame.getAttribute('src')) ?? '')

    assert.notEqual(changedMapUrl.searchParams.get('marker'), initialMapUrl.searchParams.get('marker'))
    assert.equal(await map.getAttribute('data-selected-place'), 'Palace of Fine Arts')
    assert.equal(mapRequests.length, 2)
    assert.equal(await map.locator('.hermes-openui-place-map-frame .hermes-openui-place-map-open').count(), 0)
    assert.equal(
      await map
        .getByRole('link', { name: 'Palace of Fine Arts on OpenStreetMap ↗' })
        .getAttribute('href'),
      'https://www.openstreetmap.org/way/288371295'
    )
    assert.equal(
      await map.getByRole('link', { name: 'Map data © OpenStreetMap contributors' }).getAttribute('href'),
      'https://www.openstreetmap.org/copyright'
    )

    await page.reload()
    await page.waitForFunction(
      () =>
        document.querySelector('[data-hermes-openui-place-map]')?.getAttribute('data-selected-place') ===
        'Palace of Fine Arts'
    )
    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll('[data-hermes-openui-photo] img')]
      return images.length === 3 && images.every(image => image instanceof HTMLImageElement && image.naturalWidth > 0)
    })
    assert.equal(await mapSelector.inputValue(), '1')
    assert.equal(
      new URL((await mapFrame.getAttribute('src')) ?? '').searchParams.get('marker'),
      '37.802919,-122.448403'
    )

    const desktopLayout = await photos.evaluateAll(elements =>
      elements.map(element => {
        const rect = element.getBoundingClientRect()
        return { left: rect.left, top: rect.top, width: rect.width }
      })
    )

    assert.ok(Math.max(...desktopLayout.map(rect => rect.width)) - Math.min(...desktopLayout.map(rect => rect.width)) < 0.5)
    assert.ok(Math.max(...desktopLayout.map(rect => rect.top)) - Math.min(...desktopLayout.map(rect => rect.top)) < 0.5)

    const screenshotPath = process.env.HERMES_OPENUI_PHOTO_SCREENSHOT

    if (screenshotPath) {
      await page.waitForTimeout(250)
      await page.screenshot({ fullPage: true, path: screenshotPath })
    }

    await page.setViewportSize({ height: 900, width: 360 })
    await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth)
    const mobileLayout = await photos.evaluateAll(elements =>
      elements.map(element => {
        const rect = element.getBoundingClientRect()
        return { left: rect.left, top: rect.top, width: rect.width }
      })
    )

    assert.ok(Math.max(...mobileLayout.map(rect => rect.width)) - Math.min(...mobileLayout.map(rect => rect.width)) < 0.5)
    assert.ok(Math.max(...mobileLayout.map(rect => rect.top)) - Math.min(...mobileLayout.map(rect => rect.top)) < 0.5)

    const mobileScreenshotPath = process.env.HERMES_OPENUI_PHOTO_MOBILE_SCREENSHOT

    if (mobileScreenshotPath) {
      await page.screenshot({ fullPage: true, path: mobileScreenshotPath })
    }

    await page.setViewportSize({ height: 900, width: 900 })
    await page.evaluate(() => document.documentElement.classList.add('dark'))
    assert.equal(
      await page
        .locator('[data-hermes-openui-surface]')
        .evaluate(element => getComputedStyle(element).getPropertyValue('--oui-canvas').trim()),
      '#1c1c1e'
    )

    const darkScreenshotPath = process.env.HERMES_OPENUI_PHOTO_DARK_SCREENSHOT

    if (darkScreenshotPath) {
      await page.evaluate(() => {
        document.body.style.background = '#171717'
      })
      await page.screenshot({ fullPage: true, path: darkScreenshotPath })
    }

    await page.evaluate(() => {
      document.documentElement.classList.remove('dark')
      document.body.style.background = '#f7f7f8'
    })
    await page.locator('[data-hermes-openui-photo] img').nth(2).evaluate(image => {
      image.dispatchEvent(new Event('error'))
    })
    const fallback = page.locator('[data-hermes-openui-photo-fallback]')

    await fallback.waitFor()
    assert.equal(await fallback.count(), 1)
    assert.match((await fallback.textContent()) ?? '', /cable car 55/i)
    assert.equal(await page.locator('[data-photo-state="fallback"]').getAttribute('role'), null)
    assert.equal(await fallback.getByRole('link', { name: 'View source' }).count(), 1)

    const fallbackScreenshotPath = process.env.HERMES_OPENUI_PHOTO_FALLBACK_SCREENSHOT

    if (fallbackScreenshotPath) {
      await page.screenshot({ fullPage: true, path: fallbackScreenshotPath })
    }

    assert.deepEqual(pageErrors, [])
  }
)
