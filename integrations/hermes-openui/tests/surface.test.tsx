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
  DESIGN_OPENUI_PROGRAM,
  openUILibrary,
  SAMPLE_OPENUI_PROGRAM
} from '../src/library.tsx'
import { OpenUISurface } from '../src/surface.tsx'

const FIRST_DESIGN_FRAME = `root = Card("Retrieval strategies, compared", "A compact read on the fixture's quality-speed-efficiency trade-off.", [kpis, tabs, chart, insight, checkpoint], "RESEARCH SYNTHESIS · LOCAL DESIGN FIXTURE")`

type HarnessWindow = Window & {
  __openUICalls: Array<[string, string]>
  __setOpenUI: (source: string, streaming: boolean) => void
  __setOpenUISession: (sessionId: null | string) => void
}

test('published programs satisfy the OpenUI library schema', () => {
  const parser = createParser(openUILibrary.toJSONSchema(), openUILibrary.root)
  const design = parser.parse(DESIGN_OPENUI_PROGRAM)
  const slider = parser.parse(SAMPLE_OPENUI_PROGRAM)

  assert.equal(design.root?.typeName, 'Card')
  assert.deepEqual(design.meta.errors, [])
  assert.deepEqual(design.meta.unresolved, [])
  assert.equal(design.stateDeclarations.$lens, 'Quality')
  assert.equal(design.stateDeclarations.$minimum, 75)
  assert.equal(slider.root?.typeName, 'Card')
  assert.deepEqual(slider.meta.errors, [])
  assert.deepEqual(slider.meta.unresolved, [])
})

test('the skill sample matches the runtime library', async () => {
  const skill = await readFile('skills/openui/SKILL.md', 'utf8')
  const source = skill.match(
    /<!--openui:source id="ui-retrieval-01"\n([\s\S]*?)\nopenui:end-->/
  )?.[1]
  const parser = createParser(openUILibrary.toJSONSchema(), openUILibrary.root)
  const result = parser.parse(source ?? '')

  assert.ok(source)
  assert.equal(result.root?.typeName, 'Card')
  assert.deepEqual(result.meta.errors, [])
  assert.deepEqual(result.meta.unresolved, [])
  assert.equal(result.stateDeclarations.$lens, 'Quality')
  assert.equal(result.stateDeclarations.$minimum, 75)
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

test(
  'the designed answer streams, updates locally, restores state, and follows up',
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
    await card.locator('.hermes-openui-title').filter({ hasText: 'Retrieval strategies, compared' }).waitFor()
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

    await range.fill('90')
    await page.locator('[data-hermes-openui-output]').filter({ hasText: '90%' }).waitFor()
    await page.waitForFunction(() => {
      const value = Object.values(localStorage).join(' ')
      return value.includes('Speed') && value.includes('90')
    })

    const screenshotPath = process.env.HERMES_OPENUI_SCREENSHOT

    if (screenshotPath) {
      await page.screenshot({ fullPage: true, path: screenshotPath })
    }

    const darkScreenshotPath = process.env.HERMES_OPENUI_DARK_SCREENSHOT

    if (darkScreenshotPath) {
      await page.evaluate(() => {
        document.documentElement.dataset.theme = 'dark'
        document.body.style.background = '#171717'
      })
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
