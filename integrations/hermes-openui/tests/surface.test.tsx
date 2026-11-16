import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createParser } from '@openuidev/react-lang'
import { build } from 'esbuild'
import { chromium, type Page } from 'playwright-core'
import { renderToStaticMarkup } from 'react-dom/server'

import { promptOptions } from '../src/intelligent-ui/prompt-options.ts'
import {
  DECISION_BRIEF_OPENUI_PROGRAM,
  DESIGN_OPENUI_PROGRAM,
  openUILibrary,
  PHOTO_STRIP_OPENUI_PROGRAM,
  SAMPLE_OPENUI_PROGRAM
} from '../src/library.tsx'
import { OpenUISurface } from '../src/surface.tsx'

const COMPONENTS = [
  'Badge',
  'Box',
  'Button',
  'Caption',
  'Card',
  'Carousel',
  'Celebration',
  'Chart',
  'Checkbox',
  'Circle',
  'Code',
  'Col',
  'DatePicker',
  'Divider',
  'Ellipse',
  'Flashcard',
  'Form',
  'G',
  'Grid',
  'HtmlView',
  'Icon',
  'IconButton',
  'Image',
  'Input',
  'Label',
  'Line',
  'Link',
  'List',
  'ListItem',
  'Map',
  'MapMarker',
  'Markdown',
  'Math',
  'Path',
  'Polygon',
  'Polyline',
  'Popover',
  'Pressable',
  'Quote',
  'RadioGroup',
  'Rect',
  'Row',
  'SearchImage',
  'SegmentedControl',
  'Select',
  'Slider',
  'Spacer',
  'Svg',
  'SvgText',
  'Table',
  'Text',
  'TextArea',
  'Timer',
  'Title',
  'YouTube'
] as const

const FUNCTIONS = [
  'AddDays',
  'AddMonths',
  'Allocate',
  'Append',
  'Between',
  'Bucket',
  'Capitalize',
  'Change',
  'Chunk',
  'Clamp',
  'Concat',
  'Convert',
  'Cumulative',
  'DaysBetween',
  'Default',
  'Duration',
  'Find',
  'Flatten',
  'Format',
  'FormatDate',
  'GroupBy',
  'Histogram',
  'Includes',
  'IndexOf',
  'Join',
  'Lerp',
  'Lower',
  'MixColor',
  'MonthsBetween',
  'MovingAvg',
  'Now',
  'Pad',
  'Payment',
  'Percent',
  'Pick',
  'Pivot',
  'Plural',
  'Pow',
  'Prepend',
  'Random',
  'Range',
  'Remove',
  'RemoveAt',
  'Replace',
  'Reverse',
  'Shuffle',
  'Slice',
  'Split',
  'Sqrt',
  'StartOf',
  'Stats',
  'Take',
  'Today',
  'Toggle',
  'Top',
  'Trim',
  'Unique',
  'Update',
  'Upper'
] as const

type HarnessWindow = Window & {
  __openUICalls: Array<[string, string]>
  __queryAttempts: Array<Record<string, unknown>>
  __queryControls: Array<{
    reject: (error: Error) => void
    resolve: (value: unknown) => void
  }>
  __openedUrls: string[]
  __setOpenUI: (source: string, streaming: boolean) => void
  __setOpenUISession: (sessionId: null | string) => void
}

async function mountHarness(
  t: test.TestContext,
  harness: string,
  route?: (page: Page) => Promise<void>
): Promise<{ page: Page; origin: string; workerRequests: string[] }> {
  const workspace = process.cwd()
  const temp = await mkdtemp(path.join(tmpdir(), 'hermes-openui-browser-'))
  const harnessPath = path.join(temp, 'harness.tsx')
  const worker = await readFile(
    path.join(workspace, 'node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs')
  )

  await writeFile(harnessPath, harness)
  const bundled = await build({
    absWorkingDir: workspace,
    bundle: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    entryPoints: [harnessPath],
    format: 'esm',
    jsx: 'automatic',
    loader: { '.css': 'text' },
    mainFields: ['module', 'main'],
    nodePaths: [path.join(workspace, 'node_modules')],
    platform: 'browser',
    write: false
  })
  const script = bundled.outputFiles[0].text.replaceAll('</script>', '<\\/script>')
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; }
    body { padding: 28px; background: #f7f7f8; }
    #root { margin: 0 auto; max-width: 840px; }
  </style></head><body><div id="root"></div><script type="module">${script}</script></body></html>`
  const workerRequests: string[] = []
  const server = createServer((request, response) => {
    if (request.url === '/maplibre-gl-worker.mjs') {
      workerRequests.push(request.url)
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      response.end(worker)
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(html)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()

  assert.ok(address && typeof address === 'object')
  const origin = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({
    args: [
      '--no-sandbox',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--use-angle=swiftshader'
    ],
    executablePath: '/usr/bin/chromium',
    headless: true
  })
  const page = await browser.newPage({ viewport: { height: 1000, width: 1100 } })
  const pageErrors: string[] = []

  page.setDefaultTimeout(12_000)
  page.on('pageerror', error => pageErrors.push(error.message))
  t.after(async () => {
    assert.deepEqual(pageErrors, [])
    await browser.close()
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()))
    })
    await rm(temp, { force: true, recursive: true })
  })
  await route?.(page)
  await page.goto(origin)

  return { origin, page, workerRequests }
}

test('the full component, function, action, and prompt catalog is live', () => {
  const schema = openUILibrary.toJSONSchema()
  const definitions = Object.keys(schema.$defs ?? {})
  const functions = Object.keys(schema.functions ?? {})
  const actions = Object.keys(schema.actions ?? {})

  assert.equal(openUILibrary.root, 'Col')
  assert.deepEqual(
    definitions.filter(name => name !== 'ActionExpression').sort(),
    [...COMPONENTS, 'CitationList', 'PhotoStrip', 'PlaceMap'].sort()
  )
  assert.deepEqual(functions.sort(), [...FUNCTIONS].sort())
  assert.deepEqual(actions, ['CopyToClipboard'])

  const parser = createParser(schema, openUILibrary.root)
  const programs = [
    SAMPLE_OPENUI_PROGRAM,
    DESIGN_OPENUI_PROGRAM,
    DECISION_BRIEF_OPENUI_PROGRAM,
    PHOTO_STRIP_OPENUI_PROGRAM,
    ...(promptOptions.examples ?? []).map(example => example.slice(example.indexOf('\n\n') + 2))
  ]

  for (const program of programs) {
    const result = parser.parse(program)

    assert.equal(result.root?.typeName, 'Col', program.split('\n')[0])
    assert.deepEqual(result.meta.errors, [])
    assert.deepEqual(result.meta.unresolved, [])
  }
})

test('the cited skill sample is the published decision program', async () => {
  const skill = await readFile('skills/openui/SKILL.md', 'utf8')
  const source = skill.match(
    /<!--openui:source id="ui-decision-01"\n([\s\S]*?)\nopenui:end-->/
  )?.[1]

  assert.ok(source)
  assert.equal(source, DECISION_BRIEF_OPENUI_PROGRAM)
})

test('the attribution leaves render safe links and media fallbacks', () => {
  const decision = renderToStaticMarkup(
    <OpenUISurface
      identity="decision-static"
      onFollowUp={() => true}
      sessionId="session-static"
      source={DECISION_BRIEF_OPENUI_PROGRAM}
      streaming={false}
    />
  )
  const photos = renderToStaticMarkup(
    <OpenUISurface
      identity="photos-static"
      onFollowUp={() => true}
      sessionId="session-static"
      source={PHOTO_STRIP_OPENUI_PROGRAM}
      streaming={false}
    />
  )
  const unsafe = renderToStaticMarkup(
    <OpenUISurface
      identity="unsafe-static"
      onFollowUp={() => true}
      sessionId="session-static"
      source={DECISION_BRIEF_OPENUI_PROGRAM.replace(
        'https://doi.org/10.1561/1500000019',
        'javascript:alert(1)'
      )}
      streaming={false}
    />
  )

  assert.match(decision, /Choose a retrieval path/)
  assert.match(decision, /data-hermes-openui-citations/)
  assert.match(decision, /href="https:\/\/arxiv.org\/abs\/2004.04906"/)
  assert.match(decision, /rel="noopener noreferrer"/)
  assert.match(photos, /Three views of San Francisco/)
  assert.equal((photos.match(/data-hermes-openui-photo="true"/g) ?? []).length, 3)
  assert.match(photos, /https:\/\/www.openstreetmap.org\/export\/embed.html/)
  assert.doesNotMatch(unsafe, /href="javascript:/)
  assert.match(unsafe, /data-safe-url="false"/)
})

test(
  'root-first rendering keeps the surface while controls, chart, and state complete',
  { timeout: 60_000 },
  async t => {
    const firstFrame = 'root = Col([])'
    const prefix = `root = Col([header, detail], 4)
header = Col([Title("Choose a retrieval strategy", "xl"), Text("Hybrid is the safer default.", "md", "muted")], 2)
detail = Card([Text("Scores load next.")], "soft", 4)`
    const harness = `
      import { useEffect, useState } from 'react'
      import { createRoot } from 'react-dom/client'
      import { OpenUISurface } from ${JSON.stringify(path.join(process.cwd(), 'src/surface.tsx'))}

      function Harness() {
        const [source, setSource] = useState(${JSON.stringify(firstFrame)})
        const [streaming, setStreaming] = useState(true)
        const [sessionId, setSessionId] = useState('session-main')

        useEffect(() => {
          window.__openUICalls = []
          window.__setOpenUI = (nextSource, nextStreaming) => {
            setStreaming(nextStreaming)
            setSource(nextSource)
          }
          window.__setOpenUISession = setSessionId
        }, [])

        return (
          <OpenUISurface
            identity="main-progressive"
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

      createRoot(document.getElementById('root')).render(<Harness />)
    `
    const { page } = await mountHarness(t, harness)

    const root = page.locator('.iui-col').first()

    await root.waitFor({ state: 'attached' })
    await root.evaluate(element => element.setAttribute('data-before-complete', 'true'))
    await page.evaluate(
      source => (window as unknown as HarnessWindow).__setOpenUI(source, true),
      prefix
    )
    await page.getByText('Choose a retrieval strategy', { exact: true }).waitFor()
    await page.getByText('Scores load next.', { exact: true }).waitFor()
    assert.equal(await root.getAttribute('data-before-complete'), 'true')

    await page.evaluate(
      source => (window as unknown as HarnessWindow).__setOpenUI(source, false),
      DESIGN_OPENUI_PROGRAM
    )
    await page.getByText('Illustrative scores', { exact: true }).waitFor()
    await page.locator('.iui-chart svg').waitFor()
    assert.equal(await root.getAttribute('data-before-complete'), 'true')

    const quality = page.getByRole('radio', { name: 'Quality' })

    assert.equal(await quality.getAttribute('aria-checked'), 'true')
    await page.getByRole('radio', { name: 'Speed' }).click()
    await page.locator('.iui-chart svg[aria-label*="Speed"]').waitFor()
    await page.getByText('Showing Speed scores; 75% is the evidence floor.', { exact: true }).waitFor()

    const slider = page.locator('input.iui-range')

    await slider.fill('90')
    await page.getByText('Showing Speed scores; 90% is the evidence floor.', { exact: true }).waitFor()
    await page.waitForFunction(() => Object.values(localStorage).some(value => value.includes('Speed') && value.includes('90')))

    const follow = page.getByRole('button', { name: 'Explain this trade-off' })

    await follow.click()
    await follow.click()
    assert.deepEqual(
      await page.evaluate(() => (window as unknown as HarnessWindow).__openUICalls),
      [['session-main', 'Explain the Speed comparison above 90% evidence floor.']]
    )

    await page.evaluate(() => (window as unknown as HarnessWindow).__setOpenUISession(null))
    await page.evaluate(
      source => (window as unknown as HarnessWindow).__setOpenUI(source, false),
      DESIGN_OPENUI_PROGRAM
    )
    assert.equal(
      await page.evaluate(() => (window as unknown as HarnessWindow).__openUICalls.length),
      1
    )
    await root.waitFor({ state: 'attached' })
  }
)

test(
  'Query shows loading, failure, and retry before rendering returned rows',
  { timeout: 60_000 },
  async t => {
    const program = `root = Col([header, result], 4)
header = Col([Title("Configured query", "xl"), Text("Rows come from the read-only endpoint.", "md", "muted")], 2)
data = Query("query_data", {window: "30d"}, {rows: []})
result = Table(["Order"], @Each(data.rows, "row", [row.id]))`
    const harness = `
      import { createRoot } from 'react-dom/client'
      import { OpenUISurface } from ${JSON.stringify(path.join(process.cwd(), 'src/surface.tsx'))}

      window.__queryAttempts = []
      window.__queryControls = []
      const toolProvider = {
        query_data(args) {
          window.__queryAttempts.push(args)
          return new Promise((resolve, reject) => {
            window.__queryControls.push({ resolve, reject })
          })
        }
      }

      createRoot(document.getElementById('root')).render(
        <OpenUISurface
          identity="async-query"
          onFollowUp={() => true}
          sessionId="session-query"
          source={${JSON.stringify(program)}}
          streaming={false}
          toolProvider={toolProvider}
        />
      )
    `
    const { page } = await mountHarness(t, harness)

    await page.getByText('Configured query', { exact: true }).waitFor()
    await page.getByText('Loading data…', { exact: true }).waitFor()
    await page.waitForFunction(
      () => (window as unknown as HarnessWindow).__queryControls.length === 1
    )
    assert.deepEqual(
      await page.evaluate(() => (window as unknown as HarnessWindow).__queryAttempts),
      [{ window: '30d' }]
    )

    await page.evaluate(() => {
      const harnessWindow = window as unknown as HarnessWindow
      harnessWindow.__queryControls[0]?.reject(new Error('fixture failure'))
    })
    await page.getByRole('alert').filter({
      hasText: 'The configured data source could not be loaded.'
    }).waitFor()

    await page.getByRole('button', { name: 'Try again' }).click()
    await page.waitForFunction(
      () => (window as unknown as HarnessWindow).__queryControls.length === 2
    )
    await page.evaluate(() => {
      const harnessWindow = window as unknown as HarnessWindow
      harnessWindow.__queryControls[1]?.resolve({ rows: [{ id: 'ORD-1042' }] })
    })
    await page.getByText('ORD-1042', { exact: true }).waitFor()
    assert.deepEqual(
      await page.evaluate(() => (window as unknown as HarnessWindow).__queryAttempts),
      [{ window: '30d' }, { window: '30d' }]
    )
  }
)

test(
  'clipboard, safe URL, and sandboxed HTML actions stay inside their contracts',
  { timeout: 60_000 },
  async t => {
    const program = `root = Col([header, actions, htmlView], 4)
header = Col([Title("Local actions", "xl"), Text("These controls act inside the browser.", "md", "muted")], 2)
actions = Row([Button("Copy note", @CopyToClipboard("Hermes copy test")), Button("Open docs", @OpenUrl("https://example.com/docs")), Button("Open unsafe", @OpenUrl("javascript:alert(1)"))], 2)
htmlView = HtmlView("<button id='counter'>Count <span id='n'>0</span></button><script>document.getElementById('counter').onclick=function(){document.getElementById('n').textContent=Number(document.getElementById('n').textContent)+1}</script>", 160, "Interactive counter")`
    const harness = `
      import { createRoot } from 'react-dom/client'
      import { OpenUISurface } from ${JSON.stringify(path.join(process.cwd(), 'src/surface.tsx'))}

      window.__openedUrls = []
      window.open = url => {
        window.__openedUrls.push(String(url))
        return null
      }
      createRoot(document.getElementById('root')).render(
        <OpenUISurface
          identity="local-actions"
          onFollowUp={() => true}
          sessionId="session-actions"
          source={${JSON.stringify(program)}}
          streaming={false}
        />
      )
    `
    const { origin, page } = await mountHarness(t, harness)

    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
    await page.getByText('Local actions', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Copy note' }).click()
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Hermes copy test')

    await page.getByRole('button', { name: 'Open docs' }).click()
    await page.getByRole('button', { name: 'Open unsafe' }).click()
    assert.deepEqual(
      await page.evaluate(() => (window as unknown as HarnessWindow).__openedUrls),
      ['https://example.com/docs']
    )

    const frame = page.frameLocator('iframe[title="Interactive counter"]')

    await frame.getByRole('button', { name: /Count/ }).click()
    await frame.getByText('Count 1', { exact: true }).waitFor()
    assert.equal(
      await page.locator('iframe[title="Interactive counter"]').getAttribute('sandbox'),
      'allow-scripts'
    )
    assert.match(
      await page.locator('iframe[title="Interactive counter"]').getAttribute('srcdoc') ?? '',
      /default-src 'none'/
    )
  }
)

test(
  'SearchImage uses the Wikipedia MediaWiki response and renders the returned photo',
  { timeout: 60_000 },
  async t => {
    const program = 'root = Col([SearchImage("Golden Gate Bridge", 1.5)], 4)'
    const harness = `
      import { createRoot } from 'react-dom/client'
      import { OpenUISurface } from ${JSON.stringify(path.join(process.cwd(), 'src/surface.tsx'))}

      createRoot(document.getElementById('root')).render(
        <OpenUISurface
          identity="image-search"
          onFollowUp={() => true}
          sessionId="session-image"
          source={${JSON.stringify(program)}}
          streaming={false}
        />
      )
    `
    const imageRequests: string[] = []
    const { page } = await mountHarness(t, harness, async page => {
      await page.route('https://en.wikipedia.org/w/api.php**', async route => {
        imageRequests.push(route.request().url())
        await route.fulfill({
          body: JSON.stringify({
            query: {
              pages: {
                '1': {
                  original: {
                    source:
                      'https://upload.wikimedia.org/wikipedia/commons/golden-gate-bridge.jpg'
                  }
                }
              }
            }
          }),
          contentType: 'application/json',
          status: 200
        })
      })
      await page.route('https://upload.wikimedia.org/**', async route => {
        await route.fulfill({
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#cce8f4"/></svg>',
          contentType: 'image/svg+xml',
          status: 200
        })
      })
    })
    const image = page.locator('.iui-image img')

    await image.waitFor()
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.iui-image img')].every(
        element => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0
      )
    )
    assert.equal(await image.getAttribute('alt'), 'Golden Gate Bridge')
    assert.match(await image.getAttribute('src') ?? '', /^https:\/\/upload\.wikimedia\.org\//)
    assert.equal(imageRequests.length, 1)
    assert.match(imageRequests[0] ?? '', /action=query/)
    assert.match(imageRequests[0] ?? '', /generator=search/)
  }
)

test(
  'MapLibre loads its beside-bundle worker and keeps marker selection local',
  { timeout: 60_000 },
  async t => {
    const program = `root = Col([header, map], 4)
header = Col([Title("Choose a stop", "xl"), Text("Select a marker to keep the local highlight.", "md", "muted")], 2)
map = Map([MapMarker("Golden Gate Bridge", 37.8182923, -122.4783842, "Landmark"), MapMarker("Palace of Fine Arts", 37.8029186, -122.4484029, "Landmark")], false, $selected, 360)`
    const harness = `
      import { createRoot } from 'react-dom/client'
      import { OpenUISurface } from ${JSON.stringify(path.join(process.cwd(), 'src/surface.tsx'))}

      createRoot(document.getElementById('root')).render(
        <OpenUISurface
          identity="map-selection"
          onFollowUp={() => true}
          sessionId="session-map"
          source={${JSON.stringify(program)}}
          streaming={false}
        />
      )
    `
    const { page, workerRequests } = await mountHarness(t, harness, async page => {
      await page.route('https://tiles.openfreemap.org/planet', async route => {
        await route.fulfill({
          body: JSON.stringify({
            attributions: 'OpenFreeMap',
            maxzoom: 14,
            minzoom: 0,
            tilejson: '3.0.0',
            tiles: [],
            vector_layers: []
          }),
          contentType: 'application/json',
          status: 200
        })
      })
      await page.route('https://server.arcgisonline.com/**', async route => {
        await route.abort()
      })
    })

    await page.getByText('Choose a stop', { exact: true }).waitFor()
    await page.locator('.iui-map-surface .maplibregl-canvas').waitFor()
    await page.waitForFunction(() => {
      const markers = [...document.querySelectorAll('.maplibregl-marker')]
      return markers.length === 2 && markers.every(marker => marker.getAttribute('aria-label'))
    })
    assert.ok(workerRequests.includes('/maplibre-gl-worker.mjs'))

    const goldenGate = page.getByLabel('Golden Gate Bridge')

    await goldenGate.click()
    assert.equal(await goldenGate.getAttribute('aria-pressed'), 'true')
    await page.getByLabel('Palace of Fine Arts').click()
    assert.equal(await goldenGate.getAttribute('aria-pressed'), 'false')
    assert.equal(
      await page.getByLabel('Palace of Fine Arts').getAttribute('aria-pressed'),
      'true'
    )
  }
)
