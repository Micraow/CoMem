export function estimateTokens(text) {
  let cjkChars = 0;
  let otherChars = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (
      (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
      (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
      (codePoint >= 0x3000 && codePoint <= 0x303f) ||
      (codePoint >= 0xff00 && codePoint <= 0xffef)
    ) cjkChars += 1;
    else otherChars += 1;
  }
  return Math.ceil(cjkChars + otherChars / 4);
}

export function escapeInjectionText(text) {
  let value = text;
  for (const prefix of ['comem-']) {
    value = value.replaceAll(`<${prefix}`, `‹${prefix}`).replaceAll(`</${prefix}`, `‹/${prefix}`);
  }
  return value;
}

export const DEFAULT_MAX_CONTEXT_BYTES = 9500;
export const CONTEXT_BLOCK_DROP_ORDER = Object.freeze(['recall', 'preferences', 'profile']);

export function fitContext(blocks, maxBytes) {
  const dropped = [];
  let kept = blocks.filter((block) => block.text !== '');
  const render = () => kept.map((block) => block.text).join('\n\n');
  for (const id of CONTEXT_BLOCK_DROP_ORDER) {
    if (Buffer.byteLength(render(), 'utf8') <= maxBytes) break;
    if (!kept.some((block) => block.id === id)) continue;
    dropped.push(id);
    kept = kept.filter((block) => block.id !== id);
  }
  return { context: render(), dropped };
}
