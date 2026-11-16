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
  SAMPLE_OPENUI_PROGRAM
} from '../src/library.tsx'
import { OpenUISurface } from '../src/surface.tsx'

const FIRST_DESIGN_FRAME = `root = Card("Choose a retrieval strategy", "Hybrid is the safer default for mixed exact-match and semantic queries.", [kpis, tabs, chart, insight, checkpoint, note])`

type HarnessWindow = Window & {
  __openUICalls: Array<[string, string]>
  __setOpenUI: (source: string, streaming: boolean) => void
  __setOpenUISession: (sessionId: null | string) => void
}

test('published programs satisfy the OpenUI library schema', () => {
  const parser = createParser(openUILibrary.toJSONSchema(), openUILibrary.root)
  const decisionBrief = parser.parse(DECISION_BRIEF_OPENUI_PROGRAM)
  const design = parser.parse(DESIGN_OPENUI_PROGRAM)
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

    if (darkScreenshotPath) {
      await page.evaluate(() => {
        document.documentElement.dataset.theme = 'dark'
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

    if (darkScreenshotPath) {
      await page.evaluate(() => {
        document.documentElement.dataset.theme = 'dark'
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
