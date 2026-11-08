/**
 * 注入块的文本处理：剥 frontmatter、估算 token、超预算截断、宿主字节上限。
 *
 * 四件事都属于「把服务端读到的文本变成模型看得到的上下文」，放在一起是为了能用
 * 固定输入穷举测试，不需要起 HTTP 替身。`SessionStart` 的三个块是唯一的调用方。
 *
 * ## 为什么按 CJK 密度估算，而不是 `chars / 4`
 *
 * `chars / 4` 是英文的换算法（4 个字符约 1 个 token）。中文**低估 6 倍**：一个汉字
 * 在常见 BPE 分词器里就是一个 token（少数是 1.5 个），1000 个汉字约 1000–1500
 * token，按 `chars / 4` 只有 250。用它判预算会让中文画像超上限 4–6 倍。
 *
 * 公式与 `src/domain/session.ts` 的 `estimateTokens` 一致：
 * `ceil(CJK 码点数 × 1 + 其余码点数 × 0.25)`。Hook 是独立交付物（不依赖 `src/`），
 * 所以这里保留一份副本；**两处的常量必须一起改**，改一处会让「会话自动提交」与
 * 「注入预算」对同一段文本给出两个结论。
 *
 * 误差在 ±30% 量级（emoji 偏低）。这里只用于「放不放得下」，不用于计费。
 */

/**
 * 粗估 token 数。
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  let cjkChars = 0;
  let otherChars = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (isCjk(codePoint)) {
      cjkChars += 1;
    } else {
      otherChars += 1;
    }
  }
  return Math.ceil(cjkChars + otherChars / 4);
}

/**
 * 汉字与中文标点的码点范围（与 `src/domain/session.ts` 的 `isCjk` 同一份）。
 *
 * 基本区 `U+4E00`–`U+9FFF`、扩展 A `U+3400`–`U+4DBF`、中文标点 `U+3000`–`U+303F`、
 * 全角字符 `U+FF00`–`U+FFEF`。
 *
 * @param {number} codePoint
 * @returns {boolean}
 */
function isCjk(codePoint) {
  return (
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x3000 && codePoint <= 0x303f) ||
    (codePoint >= 0xff00 && codePoint <= 0xffef)
  );
}

/** frontmatter 分隔符：行首的 `---`。 */
const FRONTMATTER_DELIMITER = '---';

/**
 * UTF-8 BOM。编辑器会在文件开头写一个，它不属于正文；留着会让「第一行是不是
 * `---`」的判定失效。
 */
const BYTE_ORDER_MARK = '\uFEFF';

/** 去掉行尾一个 `\r`（CRLF 文件）。不碰行内其它字符。 */
const TRAILING_CARRIAGE_RETURN = /\r$/;

/**
 * 剥掉 YAML frontmatter，只留正文。
 *
 * 判定规则与 `src/adapters/fs/frontmatter.ts` 的 `parseDocument` 一致：**只认第一行**
 * 的 `---`（正文中间的 `---` 是 Markdown 水平线），闭合分隔符是下一个 `---` 行；
 * 找不到闭合就按「没有 frontmatter」处理，整段都是正文。
 *
 * 为什么不用正则：frontmatter 的值里可以出现 `---`（多行字符串、分隔线），
 * `^---\n[\s\S]*?\n---` 这类惰性匹配会在第一个 `---` 处收尾，把剩下半截 YAML 当
 * 正文注入。逐行找「整行等于 `---`」才是这个格式的定义。
 *
 * 服务端 `content/read` 已经在 `ContentStore.readText` 里剥过一次；Hook 再剥一次是
 * **防御**：插件是独立部署的（`co-mem install` 装进宿主），对着旧版服务端、
 * 反向代理改写过的响应或另一个实现时，不能假设对端一定剥过。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripFrontmatter(text) {
  const normalized = text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text;

  const firstBreak = normalized.indexOf('\n');
  if (firstBreak < 0) {
    return normalized;
  }
  if (normalized.slice(0, firstBreak).replace(TRAILING_CARRIAGE_RETURN, '') !== FRONTMATTER_DELIMITER) {
    return normalized;
  }

  const lines = normalized.slice(firstBreak + 1).split('\n');
  const closing = lines.findIndex(
    (line) => line.replace(TRAILING_CARRIAGE_RETURN, '') === FRONTMATTER_DELIMITER,
  );
  if (closing < 0) {
    return normalized;
  }

  // 与 `parseDocument` 对称：只吃掉闭合分隔符之后的那一个空行，正文自己的前导换行
  // 原样保留。
  const body = lines.slice(closing + 1).join('\n');
  if (body.startsWith('\r\n')) {
    return body.slice('\r\n'.length);
  }
  return body.startsWith('\n') ? body.slice('\n'.length) : body;
}

/** 保留的前导行（句）数。8 行 = 画像开头的身份与角色，再往后是细节。 */
const HEAD_UNITS = 8;

/**
 * 句末标点。用于「正文只有一个段落」时的切分：中文画像常常是一整段散文，
 * 按行切只有一个单元，截断必须退到句子边界。
 *
 * `.` 也收：英文句子以它结尾。缩写（`Dr.`）会被切成两句，代价是多一个切点，
 * 不影响「不断在句子中间」这条要求。
 */
const SENTENCE_ENDINGS = new Set(['。', '！', '？', '；', '!', '?', ';', '.', '…', '\n']);

/**
 * 按句末标点切分，保留标点。连续标点（`……`、`...`）算一个边界。
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitSentences(text) {
  const units = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!SENTENCE_ENDINGS.has(text[index])) {
      continue;
    }
    let end = index + 1;
    while (end < text.length && SENTENCE_ENDINGS.has(text[end])) {
      end += 1;
    }
    units.push(text.slice(start, end));
    start = end;
    index = end - 1;
  }
  if (start < text.length) {
    units.push(text.slice(start));
  }
  return units;
}

/**
 * 省略标记。
 *
 * **必须写清怎么找回**：只写 `...` 的模型不知道有东西被省略，会把截断后的画像当成
 * 完整事实。工具名用 `read`（按 URI 读全文）而不是 `find`（按查询检索）——写错
 * 工具名会让模型带着一个 URI 去调检索接口，什么也查不到。
 *
 * @param {string} omitted 省略的数量（行 / 句 / 字符）
 * @param {string} unit
 * @param {string} uri
 * @returns {string}
 */
function omissionMarker(omitted, unit, uri) {
  return `[… 已省略中间 ${omitted} ${unit}；完整内容用 read 取回 ${uri} …]`;
}

/**
 * 把文本裁到 token 预算内，切点退到最近的句末。
 *
 * `estimateTokens` 单调，用二分找最长的、不超预算的前缀；找不到句末就按字符切
 * （长串没有标点的代码块或 URL 只能这样）。
 *
 * @param {string} text
 * @param {number} budgetTokens
 * @returns {string}
 */
function clipToTokens(text, budgetTokens) {
  if (estimateTokens(text) <= budgetTokens) {
    return text;
  }

  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, middle)) <= budgetTokens) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  let cut = low;
  for (let index = cut - 1; index >= 0; index -= 1) {
    if (SENTENCE_ENDINGS.has(text[index])) {
      cut = index + 1;
      break;
    }
  }
  return text.slice(0, cut).trimEnd();
}

/**
 * 超预算时保留前 N 个单元 + 尾部若干单元，中间插省略标记。
 *
 * 单元的选择：
 * - 文本有多行 → 行（`\n` 切分），省略标记写「行」；
 * - 只有一段 → 句（句末标点切分），省略标记写「句」。
 *
 * 两种都保证**不在句子中间断开**：行模式下每个单元是完整一行；句模式下的切点是
 * 句末标点。唯一的例外是单个单元本身就超预算（一整段没有标点的长文本），这时
 * 退化成「按字符裁 + 标记」，标记里写省略的字符数。
 *
 * @param {string} text
 * @param {number} budgetTokens
 * @param {string} uri 省略标记里用来找回全文的 URI
 * @returns {string}
 */
export function elideToBudget(text, budgetTokens, uri) {
  if (estimateTokens(text) <= budgetTokens) {
    return text;
  }

  const lines = text.split('\n');
  const useLines = lines.length > 1;
  const units = useLines ? lines : splitSentences(text);
  const unit = useLines ? '行' : '句';
  const separator = useLines ? '\n' : '';

  const compose = (head, tail, omitted) =>
    [head, omissionMarker(omitted, unit, uri), tail].filter((part) => part !== '').join('\n');

  if (units.length < 2) {
    const markerFor = (omittedChars) =>
      `[… 已截断 ${omittedChars} 字符；完整内容用 read 取回 ${uri} …]`;
    // 先按「全部省略」的标记长度留预算，再回填真实省略字符数（位数只会更少）。
    const available = Math.max(0, budgetTokens - estimateTokens(markerFor(text.length)) - 1);
    const clipped = clipToTokens(text, available);
    return [clipped, markerFor(text.length - clipped.length)].filter((part) => part !== '').join('\n');
  }

  const headCount = Math.min(HEAD_UNITS, units.length - 1);
  const head = units.slice(0, headCount);
  const tail = [];
  let omitted = units.length - headCount;

  for (let index = units.length - 1; index >= headCount; index -= 1) {
    tail.unshift(units[index]);
    omitted = units.length - headCount - tail.length;
    if (estimateTokens(compose(head.join(separator), tail.join(separator), omitted)) > budgetTokens) {
      tail.shift();
      omitted = units.length - headCount - tail.length;
      break;
    }
  }

  const rendered = compose(head.join(separator), tail.join(separator), omitted);
  if (estimateTokens(rendered) <= budgetTokens) {
    return rendered;
  }

  // 头部单元自身就超预算（一个巨大的段落 / 一行超长的正文）。只留能放下的前缀。
  const available = budgetTokens - estimateTokens(omissionMarker(omitted, unit, uri)) - 1;
  return `${clipToTokens(head.join(separator), Math.max(0, available))}\n${omissionMarker(
    omitted,
    unit,
    uri,
  )}`;
}

/** 块之间的分隔：空行（与原来的 `blocks.join('\n\n')` 一致）。 */
const BLOCK_SEPARATOR = '\n\n';

/**
 * 按优先级把超字节上限的块丢掉，直到整段上下文放得下。
 *
 * **优先级：画像 > 技能目录 > 偏好。** 画像是模型唯一无法从别处恢复的信息
 * （「这个用户是谁」），永远不丢；偏好是目录的 L1 概览，模型可以用 `find` /
 * `content/overview` 按需取回；技能目录是模型发现「存在哪些能力」的唯一入口，
 * 丢了没有恢复路径，所以在偏好之后丢。这个顺序与参考实现一致（先索引、再技能）。
 *
 * 调用方必须保证**画像块自身**放得下：`profileBudgetTokens` 会先按
 * `maxBytes / 4` 夹一次（见 `servers/session-start.mjs`），所以这里只需要处理
 * 「画像 + 其余块」超限。
 *
 * @param {readonly { id: 'profile' | 'preferences' | 'skills', text: string }[]} blocks
 * @param {number} maxBytes
 * @returns {{ context: string, dropped: string[] }}
 */
export function fitContext(blocks, maxBytes) {
  const dropped = [];
  let kept = blocks.filter((block) => block.text !== '');

  const render = () => kept.map((block) => block.text).join(BLOCK_SEPARATOR);

  for (const id of ['preferences', 'skills']) {
    if (Buffer.byteLength(render(), 'utf8') <= maxBytes) {
      break;
    }
    const index = kept.findIndex((block) => block.id === id);
    if (index < 0) {
      continue;
    }
    dropped.push(id);
    kept = [...kept.slice(0, index), ...kept.slice(index + 1)];
  }

  return { context: render(), dropped };
}
