import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'

registerHooks({
  resolve(specifier, context, next) {
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      path.extname(specifier) === '' &&
      context.parentURL?.startsWith('file:')
    ) {
      const base = fileURLToPath(new URL(specifier, context.parentURL))

      for (const extension of ['.ts', '.tsx']) {
        if (existsSync(`${base}${extension}`)) {
          return {
            shortCircuit: true,
            url: pathToFileURL(`${base}${extension}`).href
          }
        }
      }
      for (const extension of ['.ts', '.tsx']) {
        if (existsSync(path.join(base, `index${extension}`))) {
          return {
            shortCircuit: true,
            url: pathToFileURL(path.join(base, `index${extension}`)).href
          }
        }
      }
    }

    return next(specifier, context)
  },
  load(url, context, next) {
    if (!url.startsWith('file:')) return next(url, context)
    if (url.endsWith('.css')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `export default ${JSON.stringify(readFileSync(new URL(url), 'utf8'))}`
      }
    }
    if (!url.endsWith('.ts') && !url.endsWith('.tsx')) return next(url, context)
    return {
      format: 'module',
      shortCircuit: true,
      source: transformSync(readFileSync(new URL(url), 'utf8'), {
        format: 'esm',
        jsx: 'automatic',
        loader: url.endsWith('.tsx') ? 'tsx' : 'ts'
      }).code
    }
  }
})
