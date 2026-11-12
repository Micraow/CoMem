/**
 * 注入块的文本处理：token 估算、注入标签转义、记忆索引渲染、宿主字节上限下的降级。
 *
 * 这四件事都属于「把服务端读到的元数据变成模型看得到的上下文」，放在一起是为了能用
 * 固定输入穷举测试，不需要起 HTTP 替身。`SessionStart` 与 `UserPromptSubmit` 是调用方。
 *
 * ## 为什么是索引，不是正文
 *
 * 注入层的职责是**告诉模型「有什么」**，正文按需 `read`。整段注入画像与偏好会挤掉
 * 对话本身，而且它们变化以天计、每轮重复投喂——同一份 16 万字的画像在 100 轮会话里
 * 被付了 100 次 token 钱。所以这里只渲染 `abstract + URI`：一条记忆一行，模型看到
 * 「这条记忆知道什么」与「去哪里读全文」。URI 不能省——没有地址的索引等于删数据。
 *
 * `abstract` 来自服务端索引（`GET /content/abstract`），**不在 hook 里截断正文**：
 * 那是第二个摘要实现，两处口径必然漂移。
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

/**
 * 注入块的标签前缀。渲染前要把记忆正文里的同名标签转义掉（见 `escapeInjectionText`）。
 *
 * 两个前缀对应两类块：三个 `comem-*`（`<comem-recall>` / `<comem-profile>` /
 * `<comem-preferences>`）与技能目录的 `<available-skills>`。后者不带 `comem-` 前缀，
 * 但它同样是块边界——一条记忆作为技能描述时若含 `</available-skills>`，能提前关掉
 * 整个目录块。捕获侧的块表（`lib/sanitize.mjs` 的 `BLOCK_TAGS`）必须同步，否则只
 * 转义不剥离，注入块会以消息形式回到记忆库。
 *
 * 宿主自己的标签（`<system-reminder>` 等）不在这里处理：把宿主标签也转义会让记忆
 * 正文里正常的引用变形，而伪造宿主标签的收益远低于伪造召回块（模型按
 * `<comem-recall>` 判断「这是记忆」）。
 */
const INJECTION_TAG_PREFIXES = Object.freeze(['comem-', 'available-skills']);

/**
 * 把记忆正文里的注入标签转义成纯文本（架构文档 §15.10）。
 *
 * 一条记忆的正文里若含 `</comem-recall><comem-recall>`，原样渲染会让块**多出一层
 * 边界**：模型看到的是「这里结束了一条记忆，又开始了另一条」，于是把后面的正文
 * 当成注入协议的一部分——伪造注入。同样的伪造对 `<available-skills>` 成立：一条
 * 记忆作为技能描述时若含 `</available-skills>`，能提前关掉那个目录块。转义之后
 * 正文里只剩 `‹/comem-recall>‹comem-recall>` / `‹/available-skills>`，它仍然可读
 * （像引用了一段标签名），但不再是标签。
 *
 * ## 为什么是 `<` → `‹`（U+2039）
 *
 * - **反斜杠会把转义链引进来。** `\<comem-recall>` 在 Markdown 里是转义，在 JSON
 *   串里又是一层；模型对「反斜杠是字面量还是转义」的判断不稳定，而且正文里原本
 *   就有的反斜杠会和它混起来。
 * - **删掉标签会改变事实。** 把标签整段删掉，模型读到的是一句被改过的记忆；换成
 *   `‹` 只改一个字符，句子的其余部分原样保留。
 * - **`‹` 不会与任何标签语法混淆。** 它不是 `<`，宿主与模型都不会把它当块边界；
 *   它也不是 Markdown 元字符，不会引入第二套解析规则。
 *
 * 转义是幂等的：`‹comem-` / `‹available-skills` 里已经没有 `<` 开头的标签，再转
 * 一次不变。
 *
 * @param {string} text
 * @returns {string}
 */
export function escapeInjectionText(text) {
  let value = text;
  for (const prefix of INJECTION_TAG_PREFIXES) {
    const open = `<${prefix}`;
    // `</comem-` / `</available-skills` 以 `<` + `/` 开头，不是 `open` 的前缀，
    // 单独换。
    const close = `</${prefix}`;
    if (!value.includes(open) && !value.includes(close)) {
      continue;
    }
    value = value.replaceAll(open, `‹${prefix}`).replaceAll(close, `‹/${prefix}`);
  }
  return value;
}

/**
 * 宿主对一次 hook 输出的字节上限的兜底值。
 *
 * 逐宿主的值在 `hosts/*.mjs` 的 `MAX_CONTEXT_BYTES`（Claude Code 9,500、Codex
 * 9,500）。**调用方不传时用最严的那个**：拿不准宿主是谁，就按会静默转存文件的那个
 * 来，不能赌。DSH 插件是进程内注入、没有宿主输出上限，仍用这个默认值当保守上限。
 */
export const DEFAULT_MAX_CONTEXT_BYTES = 9500;

/**
 * 索引块首的固定说明。
 *
 * 工具名写 `read`（按 URI 读全文），不写 `find`（按查询检索）——写错工具名会让模型
 * 带着一个 URI 去调检索接口，什么也查不到。仓库里也没有 `comem read` 命令：
 * `integrations/cli.mjs` 只有 install / uninstall / doctor。
 */
export const MEMORY_INDEX_INSTRUCTION = '以下是记忆索引。需要细节时用 read 工具按 URI 读原文。';

/**
 * 一条索引记录。
 *
 * @typedef {{
 *   type: string,
 *   abstract: string | null,
 *   uri: string,
 * }} IndexEntry
 */

/**
 * 一个索引块的渲染素材。
 *
 * `entries` 是**当前保留**的条目，`total` 是原目录里的总条数；两者不等时块内会多
 * 一行「（已截断，共 M 条）」。分开存是为了让截断后还能用同一个渲染器重算，而不是
 * 在字符串上做第二次解析。
 *
 * @typedef {{
 *   open: string,
 *   close: string,
 *   entries: readonly IndexEntry[],
 *   total: number,
 * }} MemoryIndex
 */

/** 摘要里可能有多行；索引一条一行，换行与连续空白压成一个空格。 */
function singleLine(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 渲染一条索引记录：`- [类型] 摘要 · comem://…`。
 *
 * 没有摘要时只留地址——地址本身就是「这条记忆存在」的信息，丢地址等于删数据。
 * 摘要走 `escapeInjectionText`：它是记忆内容，可以含 `</comem-…>` 标签。
 *
 * @param {IndexEntry} entry
 * @returns {string}
 */
export function renderIndexEntry(entry) {
  const abstract = escapeInjectionText(singleLine(entry.abstract ?? ''));
  return abstract === '' ? `- [${entry.type}] ${entry.uri}` : `- [${entry.type}] ${abstract} · ${entry.uri}`;
}

/**
 * 渲染一个索引块：开标签、固定说明、每条记忆一行、闭标签。
 *
 * 条数少于 `total` 时在闭标签前插一行截断标记，写清「还有多少条」——只写省略号的
 * 模型不知道有东西被省略，会把截断后的索引当完整事实。
 *
 * @param {MemoryIndex} index
 * @returns {string}
 */
export function renderMemoryIndex(index) {
  const lines = [index.open, MEMORY_INDEX_INSTRUCTION, ...index.entries.map(renderIndexEntry)];
  if (index.entries.length < index.total) {
    lines.push(`（已截断，共 ${index.total} 条）`);
  }
  lines.push(index.close);
  return lines.join('\n');
}

/**
 * 从后往前丢条目，直到整块放得下。
 *
 * **至少保留 1 条**：每条都带 URI，删到最后一条等于删数据；宿主字节上限再小，
 * 也宁可让这一行留着。`measure` 由调用方给：token 预算用 `estimateTokens`，
 * 宿主字节上限用 `Buffer.byteLength`。
 *
 * @param {MemoryIndex} index
 * @param {number} budget
 * @param {(text: string) => number} measure
 * @returns {{ text: string, entries: readonly IndexEntry[] }}
 */
function fitIndexEntries(index, budget, measure) {
  const render = (count) =>
    renderMemoryIndex({
      open: index.open,
      close: index.close,
      entries: index.entries.slice(0, count),
      total: index.total,
    });

  for (let count = index.entries.length; count >= 1; count -= 1) {
    if (measure(render(count)) <= budget) {
      return { text: render(count), entries: index.entries.slice(0, count) };
    }
  }
  return { text: render(1), entries: index.entries.slice(0, 1) };
}

/**
 * 按 token 预算截断索引块（偏好目录可能有几百条，先按内容预算收一次）。
 *
 * 这是**内容预算**，与宿主字节上限是两回事：前者管「一次注入多少条」，后者管
 * 「宿主收不收得下」。默认预算 500 token ≈ 6 条中文摘要。
 *
 * @param {MemoryIndex} index
 * @param {number} budgetTokens
 * @returns {{ text: string, entries: readonly IndexEntry[] }}
 */
export function elideMemoryIndex(index, budgetTokens) {
  return fitIndexEntries(index, budgetTokens, estimateTokens);
}

/**
 * 块之间的分隔：空行（与此前的 `blocks.join('\n\n')` 一致）。
 */
const BLOCK_SEPARATOR = '\n\n';

/**
 * 注入块的降级顺序（架构文档 §15.2、§15.9）：**从最先丢到最不该丢**。
 *
 * 判据是「丢了之后还能不能拿回来」：
 *
 * 1. `skills` —— 可选能力清单，模型不靠它也能工作；
 * 2. `recall` —— 每轮重新检索，下一轮还有机会；
 * 3. `preferences` —— 索引行，模型能按 URI 读回；先截条目，截到只剩 1 条为止；
 * 4. `profile` —— 唯一无法从别处恢复的（「这个用户是谁」），最后才动，且至少保留
 *    一条带 URI 的记录。
 *
 * 前三档是**整块丢**，后两档是**索引块按条目截断**。把这张表放在这里，而不是散在
 * 调用方的 `if` 里：顺序变了只改一行，调用方不需要知道谁先谁后。
 */
export const CONTEXT_BLOCK_DROP_ORDER = Object.freeze(['skills', 'recall', 'preferences', 'profile']);

/**
 * 按显式优先级把放不下的块丢掉 / 截断，直到整段上下文放得下。
 *
 * 顺序见 `CONTEXT_BLOCK_DROP_ORDER`。索引块（带 `index` 的）截条目，其余整块丢。
 *
 * @param {readonly {
 *   id: 'profile' | 'preferences' | 'skills' | 'recall',
 *   text: string,
 *   index?: MemoryIndex,
 * }[]} blocks
 * @param {number} maxBytes
 * @returns {{ context: string, dropped: string[], truncated: string[] }}
 */
export function fitContext(blocks, maxBytes) {
  const dropped = [];
  const truncated = [];
  let kept = blocks.filter((block) => block.text !== '');

  const render = () => kept.map((block) => block.text).join(BLOCK_SEPARATOR);
  const byteLength = (text) => Buffer.byteLength(text, 'utf8');

  for (const id of CONTEXT_BLOCK_DROP_ORDER) {
    if (byteLength(render()) <= maxBytes) {
      break;
    }
    const position = kept.findIndex((block) => block.id === id);
    if (position < 0) {
      continue;
    }
    const block = kept[position];
    if (block.index === undefined) {
      dropped.push(id);
      kept = [...kept.slice(0, position), ...kept.slice(position + 1)];
      continue;
    }
    // 这一块能用的字节 = 整段上限 - 其它块占用的字节（分隔符已含在差里）。
    const budget = byteLength(block.text) - (byteLength(render()) - maxBytes);
    const fitted = fitIndexEntries(block.index, Math.max(0, budget), byteLength);
    if (fitted.text === block.text) {
      // 已经只剩 1 条（不能再截），留给下一档。
      continue;
    }
    truncated.push(id);
    kept = kept.map((item, index) =>
      index === position ? { ...item, text: fitted.text, index: { ...block.index, entries: fitted.entries } } : item,
    );
  }

  return { context: render(), dropped, truncated };
}
