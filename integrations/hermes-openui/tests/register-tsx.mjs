import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { transformSync } from 'esbuild'

registerHooks({load(url, context, next) {
  if (!url.startsWith('file:') || !url.endsWith('.tsx')) return next(url, context)
  return {format:'module', shortCircuit:true, source:transformSync(readFileSync(new URL(url), 'utf8'), {loader:'tsx', format:'esm', jsx:'automatic'}).code}
}})
