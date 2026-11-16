/**
 * Scoped adaptation of the Open Intelligent UI design tokens and component
 * rhythm. Source: https://github.com/thesysdev/open-intelligent-ui at
 * 8ecdd17297d1f15cecfbc8750817dda5a576c401, MIT licensed.
 */
export const INTELLIGENT_UI_STYLES = `
.hermes-openui-surface {
  --oui-font: var(--openui-font-body, var(--font-sans, "Inter", sans-serif));
  --oui-canvas: var(--ui-widget-surface-background, var(--ui-bg-editor, Canvas));
  --oui-ink: var(--openui-text-neutral-primary, var(--ui-text-primary, #0d0d0d));
  --oui-muted: var(--openui-text-neutral-secondary, var(--ui-text-secondary, rgb(0 0 0 / 60%)));
  --oui-faint: color-mix(in srgb, var(--oui-ink) 46%, transparent);
  --oui-surface: color-mix(in srgb, var(--oui-ink) 4%, transparent);
  --oui-surface-strong: color-mix(in srgb, var(--oui-ink) 7%, transparent);
  --oui-hover: color-mix(in srgb, var(--oui-ink) 5%, transparent);
  --oui-pressed: color-mix(in srgb, var(--oui-ink) 8%, transparent);
  --oui-border: color-mix(in srgb, var(--oui-ink) 9%, transparent);
  --oui-border-strong: color-mix(in srgb, var(--oui-ink) 14%, transparent);
  --oui-chart-1: #0285ff;
  --oui-chart-2: #00a67d;
  --oui-chart-3: #8b5cf6;
  --oui-chart-4: #f4a340;
  --oui-shadow-sm: 0 1px 3px rgb(0 0 0 / 5%);
  --oui-shadow: 0 4px 20px rgb(0 0 0 / 6%);
  color: var(--oui-ink);
  color-scheme: light;
  font-family: var(--oui-font);
  line-height: 1.5;
  max-width: 42rem;
  width: 100%;
}
/* Hermes's transcript-wide heading and paragraph rules otherwise add a
   second layer of spacing on top of the card's own layout. */
[data-slot='aui_assistant-message-content'] .aui-md .hermes-openui-surface :is(h3, h4, p, figure, ol, img) {
  margin-block: 0;
}
:is(.dark, [data-theme="dark"], [data-openui-theme="dark"]) .hermes-openui-surface {
  --oui-canvas: #1c1c1e;
  --oui-ink: #ededed;
  --oui-muted: rgb(255 255 255 / 62%);
  --oui-faint: rgb(255 255 255 / 40%);
  --oui-chart-1: #3d9dff;
  --oui-chart-2: #22bf91;
  --oui-chart-3: #a07cff;
  --oui-chart-4: #f6ae55;
  --oui-shadow-sm: 0 1px 3px rgb(0 0 0 / 28%);
  --oui-shadow: 0 4px 20px rgb(0 0 0 / 35%);
  color-scheme: dark;
}
.hermes-openui-answer {
  box-sizing: border-box;
  display: grid;
  gap: 16px;
  min-width: 0;
  padding: 2px 0 4px;
  width: 100%;
}
.hermes-openui-heading {
  display: grid;
  gap: 5px;
  min-width: 0;
}
.hermes-openui-eyebrow {
  color: var(--oui-muted);
  font-size: 10px;
  font-weight: 640;
  letter-spacing: .09em;
  line-height: 1.3;
  text-transform: uppercase;
}
.hermes-openui-title {
  color: var(--oui-ink);
  font-size: 21px;
  font-weight: 640;
  letter-spacing: -.4px;
  line-height: 1.25;
  margin: 0;
  text-wrap: balance;
}
.hermes-openui-description,
.hermes-openui-text,
.hermes-openui-caption {
  color: var(--oui-muted);
  font-size: 14px;
  line-height: 1.55;
  margin: 0;
  overflow-wrap: anywhere;
}
.hermes-openui-caption {
  font-size: 12px;
}
.hermes-openui-citations {
  border-block: 1px solid var(--oui-border);
  display: grid;
  gap: 8px;
  min-width: 0;
  padding-block: 12px;
}
.hermes-openui-citations-title {
  color: var(--oui-ink);
  font-size: 12px;
  font-weight: 640;
  letter-spacing: .015em;
  line-height: 1.4;
  margin: 0;
}
.hermes-openui-citation-list {
  counter-reset: citation;
  display: grid;
  gap: 8px;
  list-style: none;
  margin: 0;
  min-width: 0;
  padding: 0;
}
.hermes-openui-citation {
  counter-increment: citation;
  display: grid;
  gap: 9px;
  grid-template-columns: 1.35rem minmax(0, 1fr);
  min-width: 0;
}
.hermes-openui-citation::before {
  color: var(--oui-faint);
  content: "0" counter(citation);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  line-height: 1.65;
}
.hermes-openui-citation-body {
  display: grid;
  gap: 1px;
  min-width: 0;
}
.hermes-openui-citation-link {
  color: var(--oui-ink);
  font-size: 13px;
  font-weight: 590;
  line-height: 1.45;
  overflow-wrap: anywhere;
  text-decoration-color: color-mix(in srgb, var(--oui-ink) 30%, transparent);
  text-underline-offset: 3px;
}
a.hermes-openui-citation-link::after {
  color: var(--oui-muted);
  content: " ↗";
  font-size: 11px;
  font-weight: 500;
}
a.hermes-openui-citation-link:hover {
  text-decoration-color: var(--oui-ink);
}
.hermes-openui-citation-meta {
  color: var(--oui-muted);
  font-size: 11px;
  line-height: 1.45;
}
.hermes-openui-citation-note {
  color: var(--oui-faint);
  font-size: 11px;
  line-height: 1.5;
  margin-top: 2px;
}
.hermes-openui-photo-strip {
  display: grid;
  gap: 9px;
  min-width: 0;
}
.hermes-openui-photo-strip-title {
  color: var(--oui-ink);
  font-size: 12px;
  font-weight: 640;
  letter-spacing: .015em;
  line-height: 1.4;
  margin: 0;
}
.hermes-openui-photo-grid {
  display: grid;
  gap: 8px;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  min-width: 0;
}
.hermes-openui-photo {
  display: grid;
  gap: 5px;
  margin: 0;
  min-width: 0;
}
.hermes-openui-photo-frame {
  aspect-ratio: 3 / 2;
  background: var(--oui-surface);
  border-radius: 12px;
  min-width: 0;
  overflow: hidden;
  position: relative;
}
.hermes-openui-photo-frame img {
  display: block;
  height: 100%;
  inset: 0;
  object-fit: cover;
  position: absolute;
  width: 100%;
}
.hermes-openui-photo-fallback {
  align-content: end;
  background: var(--oui-surface);
  box-sizing: border-box;
  display: grid;
  gap: 5px;
  height: 100%;
  padding: 9px;
}
.hermes-openui-photo-fallback > span {
  color: var(--oui-muted);
  font-size: 11px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.hermes-openui-photo-caption {
  display: grid;
  gap: 1px;
  min-width: 0;
}
.hermes-openui-photo-label {
  color: var(--oui-ink);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.hermes-openui-photo-credit {
  color: var(--oui-muted);
  font-size: 10px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.hermes-openui-photo-source {
  color: inherit;
  text-decoration-color: color-mix(in srgb, var(--oui-ink) 30%, transparent);
  text-underline-offset: 2px;
}
.hermes-openui-photo-source:hover {
  text-decoration-color: currentColor;
}
.hermes-openui-place-map {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.hermes-openui-place-map-title {
  color: var(--oui-ink);
  font-size: 12px;
  font-weight: 640;
  letter-spacing: .015em;
  line-height: 1.4;
  margin: 0;
}
.hermes-openui-place-map-frame {
  aspect-ratio: 3 / 2;
  background: var(--oui-surface);
  border: 1px solid var(--oui-border);
  border-radius: 18px;
  isolation: isolate;
  min-width: 0;
  overflow: hidden;
  position: relative;
}
.hermes-openui-place-map-embed {
  border: 0;
  height: 100%;
  inset: 0;
  position: absolute;
  width: 100%;
  z-index: 0;
}
.hermes-openui-place-map-selector {
  align-items: center;
  backdrop-filter: blur(12px) saturate(1.4);
  background: color-mix(in srgb, var(--oui-canvas) 88%, transparent);
  border: 1px solid color-mix(in srgb, var(--oui-ink) 10%, transparent);
  border-radius: 999px;
  box-shadow: 0 2px 12px rgb(0 0 0 / 8%);
  display: flex;
  left: 12px;
  max-width: min(18rem, calc(100% - 24px));
  min-height: 34px;
  position: absolute;
  top: 12px;
  z-index: 2;
}
.hermes-openui-place-map-selector::after {
  color: var(--oui-ink);
  content: "⌄";
  font-size: 13px;
  line-height: 1;
  pointer-events: none;
  position: absolute;
  right: 11px;
}
.hermes-openui-place-map-selector select {
  appearance: none;
  background: transparent;
  border: 0;
  color: var(--oui-ink);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 560;
  line-height: 1.4;
  max-width: 100%;
  min-height: 32px;
  padding: 6px 32px 6px 12px;
  width: 100%;
}
.hermes-openui-place-map-open {
  color: var(--oui-ink);
  font-size: 11px;
  font-weight: 560;
  line-height: 1.45;
  text-decoration: none;
}
.hermes-openui-place-map-fallback {
  align-content: center;
  color: var(--oui-muted);
  display: grid;
  font-size: 12px;
  gap: 7px;
  height: 100%;
  justify-items: start;
  padding: 24px;
}
.hermes-openui-place-map-fallback a,
.hermes-openui-place-map-footer a {
  color: var(--oui-ink);
  text-decoration-color: color-mix(in srgb, var(--oui-ink) 30%, transparent);
  text-underline-offset: 2px;
}
.hermes-openui-place-map-footer {
  align-items: baseline;
  color: var(--oui-muted);
  display: flex;
  flex-wrap: wrap;
  font-size: 10px;
  gap: 4px 12px;
  justify-content: space-between;
  line-height: 1.45;
}
.hermes-openui-row {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  min-width: 0;
}
.hermes-openui-kpis {
  border-block: 1px solid var(--oui-border);
  display: grid;
  gap: 0;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  min-width: 0;
  padding-block: 11px;
}
.hermes-openui-kpi {
  display: grid;
  gap: 2px;
  min-width: 0;
  padding-inline: 14px;
}
.hermes-openui-kpi:first-child {
  padding-left: 0;
}
.hermes-openui-kpi:last-child {
  padding-right: 0;
}
.hermes-openui-kpi + .hermes-openui-kpi {
  border-left: 1px solid var(--oui-border);
}
.hermes-openui-kpi-label {
  color: var(--oui-muted);
  font-size: 11px;
  font-weight: 560;
  letter-spacing: .02em;
  line-height: 1.35;
}
.hermes-openui-kpi-value {
  color: var(--oui-ink);
  font-size: 22px;
  font-variant-numeric: tabular-nums;
  font-weight: 640;
  letter-spacing: -.6px;
  line-height: 1.15;
}
.hermes-openui-kpi-note {
  color: var(--oui-faint);
  font-size: 11px;
  line-height: 1.4;
}
.hermes-openui-segmented {
  align-self: start;
  background: var(--oui-surface);
  border-radius: 999px;
  display: inline-flex;
  gap: 2px;
  max-width: 100%;
  overflow-x: auto;
  padding: 3px;
  scrollbar-width: none;
}
.hermes-openui-segmented::-webkit-scrollbar {
  display: none;
}
.hermes-openui-segmented button {
  background: transparent;
  border: 0;
  border-radius: 999px;
  color: var(--oui-muted);
  cursor: pointer;
  flex: 1 0 auto;
  font: inherit;
  font-size: 13px;
  line-height: 1.4;
  min-height: 28px;
  padding: 4px 13px;
  transition: background .18s ease, color .18s ease, box-shadow .18s ease;
  white-space: nowrap;
}
.hermes-openui-segmented button:hover:not(.is-selected):not(:disabled) {
  color: var(--oui-ink);
}
.hermes-openui-segmented button.is-selected {
  background: var(--oui-canvas);
  box-shadow: var(--oui-shadow-sm), 0 0 0 1px var(--oui-border);
  color: var(--oui-ink);
  font-weight: 560;
}
.hermes-openui-segmented button:disabled {
  cursor: default;
  opacity: .55;
}
.hermes-openui-benchmark {
  background:
    radial-gradient(circle at 92% 10%, color-mix(in srgb, var(--oui-chart-1) 10%, transparent), transparent 34%),
    var(--oui-surface);
  border: 1px solid var(--oui-border);
  border-radius: 16px;
  box-shadow: var(--oui-shadow);
  display: grid;
  gap: 13px;
  min-width: 0;
  overflow: hidden;
  padding: 16px;
}
.hermes-openui-benchmark-head {
  align-items: end;
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  justify-content: space-between;
}
.hermes-openui-benchmark-title {
  color: var(--oui-ink);
  font-size: 14px;
  font-weight: 640;
  letter-spacing: -.15px;
  line-height: 1.35;
  margin: 0;
}
.hermes-openui-benchmark-meta {
  color: var(--oui-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.hermes-openui-benchmark-meta strong {
  color: var(--oui-ink);
  font-weight: 640;
}
.hermes-openui-bars {
  display: grid;
  gap: 11px;
  min-width: 0;
}
.hermes-openui-bar-row {
  align-items: center;
  display: grid;
  gap: 9px;
  grid-template-columns: 1.6rem minmax(5.5rem, 8rem) minmax(4rem, 1fr) 2.6rem;
  min-width: 0;
}
.hermes-openui-bar-rank {
  color: var(--oui-faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.hermes-openui-bar-label {
  color: var(--oui-ink);
  font-size: 13px;
  font-weight: 560;
  line-height: 1.4;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hermes-openui-bar-track {
  background: color-mix(in srgb, var(--oui-ink) 6%, transparent);
  border-radius: 999px;
  height: 10px;
  min-width: 0;
  overflow: hidden;
}
.hermes-openui-bar-fill {
  background: var(--oui-chart-1);
  border-radius: inherit;
  display: block;
  height: 100%;
  min-width: 3px;
  opacity: 1;
  transform-origin: left;
  transition: width .35s cubic-bezier(.2, .7, .2, 1), opacity .2s ease;
}
.hermes-openui-bar-row.is-2 .hermes-openui-bar-fill {
  background: var(--oui-chart-2);
}
.hermes-openui-bar-row.is-3 .hermes-openui-bar-fill {
  background: var(--oui-chart-3);
}
.hermes-openui-bar-row.is-below .hermes-openui-bar-fill {
  opacity: .28;
}
.hermes-openui-bar-value {
  color: var(--oui-ink);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  font-weight: 640;
  text-align: right;
}
.hermes-openui-insight {
  align-items: start;
  display: grid;
  gap: 8px;
  grid-template-columns: 7px minmax(0, 1fr);
}
.hermes-openui-insight::before {
  background: var(--oui-chart-1);
  border-radius: 999px;
  content: "";
  height: 7px;
  margin-top: 6px;
  width: 7px;
}
.hermes-openui-insight .hermes-openui-text {
  color: var(--oui-ink);
}
.hermes-openui-checkpoint {
  align-items: center;
  border-top: 1px solid var(--oui-border);
  display: grid;
  gap: 14px;
  grid-template-columns: minmax(12rem, 1fr) auto;
  padding-top: 12px;
}
.hermes-openui-slider {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.hermes-openui-slider-head {
  align-items: baseline;
  display: flex;
  font-size: 12px;
  gap: 12px;
  justify-content: space-between;
  line-height: 1.4;
}
.hermes-openui-slider-head label {
  color: var(--oui-ink);
  font-weight: 560;
}
.hermes-openui-slider-head output {
  color: var(--oui-ink);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  font-weight: 640;
}
.hermes-openui-slider input {
  appearance: none;
  -webkit-appearance: none;
  background: transparent;
  border: 0;
  border-radius: 999px;
  cursor: pointer;
  display: block;
  height: 28px;
  margin: 0;
  outline: none;
  width: 100%;
}
.hermes-openui-slider input::-webkit-slider-runnable-track {
  background: var(--oui-surface-strong);
  border: 3px solid transparent;
  border-radius: 999px;
  height: 20px;
}
.hermes-openui-slider input::-webkit-slider-thumb {
  appearance: none;
  -webkit-appearance: none;
  background: var(--oui-ink);
  border: 0;
  border-radius: 50%;
  height: 16px;
  margin-top: 2px;
  width: 16px;
}
.hermes-openui-slider input::-moz-range-track {
  background: var(--oui-surface-strong);
  border-radius: 999px;
  height: 14px;
}
.hermes-openui-slider input::-moz-range-thumb {
  background: var(--oui-ink);
  border: 0;
  border-radius: 50%;
  height: 16px;
  width: 16px;
}
.hermes-openui-slider input:focus-visible {
  outline: none;
}
.hermes-openui-slider input:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 0 0 2px var(--oui-canvas), 0 0 0 4px var(--oui-ink);
}
.hermes-openui-slider input:focus-visible::-moz-range-thumb {
  box-shadow: 0 0 0 2px var(--oui-canvas), 0 0 0 4px var(--oui-ink);
}
.hermes-openui-action {
  align-items: center;
  align-self: center;
  background: var(--oui-ink);
  border: 1px solid transparent;
  border-radius: 999px;
  color: var(--oui-canvas);
  cursor: pointer;
  display: inline-flex;
  font: inherit;
  font-size: 13px;
  font-weight: 560;
  gap: 8px;
  justify-content: center;
  line-height: 1.2;
  min-height: 36px;
  padding: 8px 15px;
  transition: filter .15s ease, transform .15s ease;
  white-space: nowrap;
}
.hermes-openui-action::after {
  content: "→";
  font-size: 14px;
}
.hermes-openui-action:hover:not(:disabled) {
  filter: brightness(1.08);
  transform: translateY(-1px);
}
.hermes-openui-action:active:not(:disabled) {
  transform: translateY(0);
}
.hermes-openui-action:disabled,
.hermes-openui-slider input:disabled {
  cursor: default;
  opacity: .45;
}
.hermes-openui-action:focus-visible,
.hermes-openui-segmented button:focus-visible,
.hermes-openui-citation-link:focus-visible,
.hermes-openui-photo-source:focus-visible,
.hermes-openui-place-map-selector select:focus-visible,
.hermes-openui-place-map-open:focus-visible,
.hermes-openui-place-map-footer a:focus-visible,
.hermes-openui-place-map-fallback a:focus-visible {
  outline: 2px solid var(--oui-ink);
  outline-offset: 3px;
}
.hermes-openui-error {
  color: var(--oui-muted);
  font-size: 12px;
  margin: 6px 0 0;
}
@media (max-width: 600px) {
  .hermes-openui-answer {
    gap: 14px;
  }
  .hermes-openui-title {
    font-size: 20px;
  }
  .hermes-openui-kpis {
    gap: 12px;
    grid-template-columns: 1fr;
  }
  .hermes-openui-kpi {
    border-left: 0 !important;
    grid-template-columns: minmax(0, 1fr) auto;
    padding: 0;
  }
  .hermes-openui-kpi-note {
    grid-column: 1 / -1;
  }
  .hermes-openui-kpi + .hermes-openui-kpi {
    border-top: 1px solid var(--oui-border);
    padding-top: 12px;
  }
  .hermes-openui-benchmark {
    border-radius: 16px;
    padding: 15px;
  }
  .hermes-openui-bar-row {
    grid-template-columns: minmax(5rem, 1fr) minmax(3rem, .85fr) 2.5rem;
  }
  .hermes-openui-bar-rank {
    display: none;
  }
  .hermes-openui-checkpoint {
    align-items: stretch;
    grid-template-columns: 1fr;
  }
  .hermes-openui-photo-grid {
    gap: 6px;
  }
  .hermes-openui-photo-frame {
    border-radius: 9px;
  }
  .hermes-openui-photo-fallback {
    padding: 6px;
  }
  .hermes-openui-photo-label {
    font-size: 10.5px;
  }
  .hermes-openui-photo-credit {
    font-size: 9.5px;
  }
  .hermes-openui-place-map-frame {
    border-radius: 14px;
  }
  .hermes-openui-place-map-selector {
    left: 9px;
    max-width: calc(100% - 18px);
    top: 9px;
  }
  .hermes-openui-action {
    justify-self: start;
  }
}
@media (prefers-reduced-motion: reduce) {
  .hermes-openui-bar-fill,
  .hermes-openui-action,
  .hermes-openui-segmented button {
    transition: none;
  }
}
`
