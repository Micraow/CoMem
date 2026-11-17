import katexCss from 'katex/dist/katex.min.css'
import mapLibreCss from 'maplibre-gl/dist/maplibre-gl.css'

import componentsCss from './components/components.css'
import mapCss from './components/map/map.css'
import themeCss from './components/theme.css'
import { INTELLIGENT_UI_STYLES } from './theme.ts'

const HERMES_STYLES = `
.hermes-openui-renderer { display: block; position: relative; }
.hermes-openui-query-status {
  align-items: center;
  color: var(--iui-muted);
  display: flex;
  font-size: 12px;
  gap: 8px;
  margin: 8px 0;
}
.hermes-openui-query-status button {
  background: var(--iui-surface);
  border: 1px solid var(--iui-border);
  border-radius: 8px;
  color: var(--iui-ink);
  cursor: pointer;
  font: inherit;
  padding: 5px 9px;
}
`

export const OPENUI_STYLES = [
  themeCss,
  componentsCss,
  mapCss,
  mapLibreCss,
  katexCss,
  INTELLIGENT_UI_STYLES,
  HERMES_STYLES
].join('\n')
