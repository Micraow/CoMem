import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createParser } from '@openuidev/react-lang'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { renderToStaticMarkup } from 'react-dom/server'

import { openUILibrary, SAMPLE_OPENUI_PROGRAM } from '../src/library.tsx'
import { OpenUISurface } from '../src/surface.tsx'

const FIRST_OPENUI_FRAME = `$minimum = 70
readout = Text("Showing results with at least " + $minimum + "% relevance.")
root = Card("Filter results", "Move the threshold to narrow the set locally.", [readout])`

type HarnessWindow = Window & {
  __openUICalls: Array<[string, string]>
  __setOpenUI: (source: string, streaming: boolean) => void
  __setOpenUISession: (sessionId: null | string) => void
}

test('the sample program satisfies the published library schema', () => {
  const parser = createParser(openUILibrary.toJSONSchema(), openUILibrary.root)
  const result = parser.parse(SAMPLE_OPENUI_PROGRAM)

  assert.equal(result.root?.typeName, 'Card')
  assert.deepEqual(result.meta.errors, [])
  assert.deepEqual(result.meta.unresolved, [])
  assert.equal(result.stateDeclarations.$minimum, 70)
})

test('the surface renders its initial slider and follow-up through the real Renderer', () => {
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
  assert.match(html, /--ui-widget-surface-background/)
})

test(
  'the mounted renderer grows before completion, keeps local state, and restores it on refresh',
  { timeout: 60_000 },
  async t => {
    const workspace = process.cwd()
    const surfacePath = path.join(workspace, 'src/surface.tsx')
    const firstFrameSource = JSON.stringify(FIRST_OPENUI_FRAME)
    const completeFrame = {
      source: SAMPLE_OPENUI_PROGRAM.replace(
        'Move the threshold to narrow the set locally.',
        'Move the threshold to narrow the set locally. Updated.'
      ),
      streaming: false
    }
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
            identity="filter-card-a"
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
        --font-sans: ui-sans-serif, sans-serif;
        --ui-accent: #a24d2a;
        --ui-bg-editor: #fffdf9;
        --ui-control-hover-background: #f1ece6;
        --ui-stroke-secondary: #d8d1c8;
        --ui-text-primary: #231f1c;
        --ui-text-secondary: #6f655d;
        --ui-widget-surface-background: #fffdf9;
      }
      body { margin: 0; padding: 24px; background: #f4f1ec; }
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
    const page = await browser.newPage()
    const pageErrors: string[] = []

    page.setDefaultTimeout(5_000)
    page.on('console', message => console.error(`[browser:${message.type()}] ${message.text()}`))
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.goto(`http://127.0.0.1:${address.port}`)
    await page
      .waitForFunction(() => typeof (window as unknown as HarnessWindow).__setOpenUI === 'function')
      .catch(async error => {
        console.error('root:', await page.locator('#root').innerHTML())
        console.error('page errors:', pageErrors)
        throw error
      })
    assert.deepEqual(pageErrors, [])

    const range = page.locator('[data-hermes-openui-range]')
    const card = page.locator('[data-hermes-openui-card]')
    const followUp = page.getByRole('button', { name: 'Explain these results' })

    await card.waitFor()
    assert.equal(await page.locator('[data-hermes-openui-surface]').getAttribute(
      'data-hermes-openui-identity'
    ), 'filter-card-a')
    assert.equal(await range.count(), 0)
    assert.equal(await followUp.count(), 0)
    await page.locator('[data-hermes-openui-card] .hermes-openui-text').filter({ hasText: '70%' }).waitFor()
    await card.evaluate(element => element.setAttribute('data-first-card', 'true'))
    await card.evaluate(element => element.setAttribute('data-before-complete', 'true'))
    await page.evaluate(
      ({ source, streaming }) => (window as unknown as HarnessWindow).__setOpenUI(source, streaming),
      growingFrame
    )
    await page
      .waitForFunction(() =>
        document.querySelector('[data-hermes-openui-card]')?.textContent?.includes('Updated.')
      )
      .catch(async error => {
        console.error('card:', await card.textContent())
        console.error('page errors:', pageErrors)
        throw error
      })
    assert.equal(await card.getAttribute('data-first-card'), 'true')
    assert.equal(await card.getAttribute('data-before-complete'), 'true')
    await range.waitFor()
    await followUp.waitFor()
    assert.equal(await range.inputValue(), '70')
    assert.equal(await range.isDisabled(), true)
    assert.equal(await followUp.isDisabled(), true)

    await page.evaluate(
      frame => (window as unknown as HarnessWindow).__setOpenUI(frame.source, frame.streaming),
      completeFrame
    )
    await page.waitForFunction(
      () => !(document.querySelector('[data-hermes-openui-range]') as HTMLInputElement | null)?.disabled
    )
    assert.equal(await card.getAttribute('data-first-card'), 'true')
    assert.equal(await card.getAttribute('data-before-complete'), 'true')

    await range.fill('85')
    await page.locator('[data-hermes-openui-output]').filter({ hasText: '85%' }).waitFor()
    await page.locator('[data-hermes-openui-card] .hermes-openui-text').filter({ hasText: '85%' }).waitFor()
    await page
      .waitForFunction(() =>
        Object.entries(localStorage).some(
          ([key, value]) => key.startsWith('hermes.openui.state.v1:') && value.includes('85')
        )
      )
      .catch(async error => {
        console.error('storage:', await page.evaluate(() => ({ ...localStorage })))
        console.error('page errors:', pageErrors)
        throw error
      })

    await page.reload()
    await page
      .waitForFunction(() => typeof (window as unknown as HarnessWindow).__setOpenUI === 'function')
      .catch(async error => {
        console.error('root after refresh:', await page.locator('#root').innerHTML())
        console.error('page errors:', pageErrors)
        throw error
      })
    await page.locator('[data-hermes-openui-card] .hermes-openui-text').filter({ hasText: '85%' }).waitFor()
    await page.evaluate(
      frame => (window as unknown as HarnessWindow).__setOpenUI(frame.source, frame.streaming),
      completeFrame
    )
    await range.waitFor()
    await page.waitForFunction(
      () => !(document.querySelector('[data-hermes-openui-range]') as HTMLInputElement | null)?.disabled
    )
    assert.equal(await range.inputValue(), '85')
    await page.locator('[data-hermes-openui-output]').filter({ hasText: '85%' }).waitFor()

    const screenshotPath = process.env.HERMES_OPENUI_SCREENSHOT

    if (screenshotPath) {
      await page.screenshot({ fullPage: true, path: screenshotPath })
    }

    await followUp.click()
    await followUp.click()
    assert.deepEqual(await page.evaluate(() => (window as unknown as HarnessWindow).__openUICalls), [
      [
        'session-a',
        'Explain the current results at this relevance threshold.'
      ]
    ])

    await page.evaluate(() => (window as unknown as HarnessWindow).__setOpenUISession(null))
    await followUp.click()
    assert.equal(await page.evaluate(() => (window as unknown as HarnessWindow).__openUICalls.length), 1)
    assert.deepEqual(pageErrors, [])
  }
)
