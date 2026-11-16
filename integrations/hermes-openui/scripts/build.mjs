import { copyFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const desktop = path.join(root, 'desktop')

const inlineKatexFonts = {
  name: 'inline-katex-fonts',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^react-dom(?:\/.*)?$/ }, () => {
      throw new Error('Hermes runtime plugins may only import @hermes/plugin-sdk and react')
    })
    buildApi.onLoad(
      { filter: /[\\/]katex[\\/]dist[\\/]katex\.min\.css$/ },
      async args => {
        let css = await readFile(args.path, 'utf8')
        const fontDirectory = path.join(path.dirname(args.path), 'fonts')
        const woff2Urls = new Set(
          [...css.matchAll(/url\(fonts\/([^)]+\.woff2)\)/g)].map(match => match[1])
        )

        for (const name of woff2Urls) {
          const bytes = await readFile(path.join(fontDirectory, name))
          css = css.replaceAll(
            `url(fonts/${name})`,
            `url(data:font/woff2;base64,${bytes.toString('base64')})`
          )
        }

        css = css.replaceAll(
          /,url\(fonts\/[^)]+\.woff\) format\("woff"\),url\(fonts\/[^)]+\.ttf\) format\("truetype"\)/g,
          ''
        )

        if (css.includes('url(fonts/')) {
          throw new Error('KaTeX stylesheet still contains an unresolved local font URL')
        }

        return { contents: css, loader: 'text' }
      }
    )
  }
}

await mkdir(desktop, { recursive: true })
await build({
  absWorkingDir: root,
  bundle: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  entryPoints: ['src/plugin.tsx'],
  external: ['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'],
  format: 'esm',
  jsx: 'automatic',
  loader: { '.css': 'text' },
  mainFields: ['module', 'main'],
  minify: true,
  outfile: path.join(desktop, 'plugin.js'),
  platform: 'browser',
  plugins: [inlineKatexFonts],
  target: 'es2022'
})

await copyFile(
  path.join(root, 'node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs'),
  path.join(desktop, 'maplibre-gl-worker.mjs')
)
