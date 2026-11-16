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
  --oui-shadow: 0 14px 40px rgb(0 0 0 / 6%);
  color: var(--oui-ink);
  color-scheme: light;
  font-family: var(--oui-font);
  line-height: 1.5;
  max-width: 42rem;
  width: 100%;
}
:is([data-theme="dark"], [data-openui-theme="dark"]) .hermes-openui-surface {
  --oui-canvas: #1c1c1e;
  --oui-ink: #ededed;
  --oui-muted: rgb(255 255 255 / 62%);
  --oui-faint: rgb(255 255 255 / 40%);
  --oui-chart-1: #3d9dff;
  --oui-chart-2: #22bf91;
  --oui-chart-3: #a07cff;
  --oui-chart-4: #f6ae55;
  --oui-shadow-sm: 0 1px 3px rgb(0 0 0 / 28%);
  --oui-shadow: 0 14px 40px rgb(0 0 0 / 30%);
  color-scheme: dark;
}
.hermes-openui-answer {
  box-sizing: border-box;
  display: grid;
  gap: 20px;
  min-width: 0;
  padding: 2px 0 4px;
  width: 100%;
}
.hermes-openui-heading {
  display: grid;
  gap: 7px;
  min-width: 0;
}
.hermes-openui-eyebrow {
  color: var(--oui-muted);
  font-size: 11px;
  font-weight: 640;
  letter-spacing: .11em;
  line-height: 1.3;
  text-transform: uppercase;
}
.hermes-openui-title {
  color: var(--oui-ink);
  font-size: 22px;
  font-weight: 640;
  letter-spacing: -.55px;
  line-height: 1.2;
  margin: 0;
}
.hermes-openui-description,
.hermes-openui-text,
.hermes-openui-caption {
  color: var(--oui-muted);
  font-size: 14px;
  line-height: 1.6;
  margin: 0;
  overflow-wrap: anywhere;
}
.hermes-openui-caption {
  font-size: 12px;
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
  padding-block: 14px;
}
.hermes-openui-kpi {
  display: grid;
  gap: 2px;
  min-width: 0;
  padding-inline: 16px;
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
  font-size: 24px;
  font-variant-numeric: tabular-nums;
  font-weight: 640;
  letter-spacing: -.6px;
  line-height: 1.2;
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
  min-height: 30px;
  padding: 5px 14px;
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
  border-radius: 18px;
  box-shadow: var(--oui-shadow);
  display: grid;
  gap: 16px;
  min-width: 0;
  overflow: hidden;
  padding: 18px;
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
  font-size: 15px;
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
  gap: 13px;
  min-width: 0;
}
.hermes-openui-bar-row {
  align-items: center;
  display: grid;
  gap: 10px;
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
  height: 12px;
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
  gap: 10px;
  grid-template-columns: 8px minmax(0, 1fr);
}
.hermes-openui-insight::before {
  background: var(--oui-chart-1);
  border-radius: 999px;
  content: "";
  height: 8px;
  margin-top: 6px;
  width: 8px;
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
  padding-top: 16px;
}
.hermes-openui-slider {
  display: grid;
  gap: 4px;
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
  cursor: pointer;
  display: block;
  height: 32px;
  margin: 0;
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
  min-height: 38px;
  padding: 9px 16px;
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
.hermes-openui-slider input:focus-visible,
.hermes-openui-segmented button:focus-visible {
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
    gap: 17px;
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
