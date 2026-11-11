/**
 * 捕获侧剥离：把 CoMem 自己注入的块从会话文本里去掉（架构文档 §15.10）。
 *
 * CoMem 往宿主上下文里塞三个块：`<comem-profile>` / `<comem-preferences>`
 * （`SessionStart`）与 `<comem-recall>`（`UserPromptSubmit`）。这些块会**留在会话
 * 里**——下一轮 `Stop` 读 transcript 时，它们与用户真的说过的话长得一模一样。
 * 原样上报的后果是「上一轮注入的记忆」以「用户这轮说的话」的身份被重新抽取一遍，
 * 跑几轮之后记忆库开始复读自己：**自我污染**。
 *
 * 宿主自己的 `<system-reminder>` 同理（它是宿主写给模型看的，不是对话），一起剥。
 *
 * ## 为什么按「开标签 → 最近的闭标签」剥，而不是贪婪正则
 *
 * `<comem-recall>[\s\S]*</comem-recall>` 会从**第一个**开标签吃到**最后一个**闭
 * 标签：同一段文本里有两个块时，中间用户真正写的内容被一起删掉。惰性匹配
 * （`*?`）只解决「一个块」的情况，嵌套时仍然会在内层闭标签处收尾。这里的判据是
 * 格式的定义：一个块从开标签到它自己的闭标签，块与块之间是正文。`indexOf` 找到
 * 开标签，再从开标签之后找第一个闭标签，就是这条定义。
 *
 * 开标签找不到闭标签时（用户手写了一截、transcript 被截断）吃到**消息末尾**：
 * 留半截注入块比删掉一段正文更糟——那半截会被当成用户的话抽取。
 *
 * ## 三种规则的作用顺序是有含义的
 *
 * 1. **块级**：先剥块。块内部的裸数字（`1. [profile] …`、时间戳）不该走后面的
 *    规则——它们属于被剥掉的内容。
 * 2. **行级**：行首的 `[2024-01-01T00:00:00Z]` 时间戳。宿主给消息加的前缀，
 *    进抽取器是纯噪声。
 * 3. **兜底**：裸 epoch 数字，**只在整条消息剥完块之后**做。块内的数字已经被第 1
 *    步带走；先做这一步会把正常的十位数（订单号、端口区间）一起吃掉。
 *
 * 三条都是**每条消息各做一次**，不是整个 transcript 做一次：transcript 是宿主写的
 * 格式，剥离只该碰 `parts[].text`。
 *
 * ## 剥离会误伤什么
 *
 * 规则认的是字符串，不是「这是不是真的注入」。用户手写的示例会被吃掉：
 *
 * - 讨论 CoMem 时贴出的 `<comem-recall>…</comem-recall>` 示例整段消失；
 * - 行首的 `[2024-01-01T00:00:00Z]` 日志片段丢掉时间戳；
 * - 恰好落在 `16…`–`19…` 的 10 / 13 位数字（部分订单号、`1700000000000` 这类
 *   epoch 毫秒）被删掉。
 *
 * 这些代价换的是「不自我污染」。剥离规则越保守，复读越严重；越激进，用户手写的
 * 示例越容易被吃。当前取舍是**只认 `comem-*` 三个块与宿主的 `<system-reminder>`**，
 * 不扩大到「任何 XML 风格的标签」。第四个注入块 `<available-skills>` 不在列表里
 * ——残余清单在 `integrations/README.md` 的「误伤与残余」。
 *
 * ## 纯函数
 *
 * 两个导出都不碰文件系统、不读配置、不发请求。`stop.mjs` 在**发 HTTP 之前**调一次
 * （`captureSession` 里），三个宿主适配器都不各剥一次——同一件事只有一个位置。
 */

/**
 * 会被整体剥离的块标签。
 *
 * 三个 `comem-*` 是 CoMem 自己写的（`servers/session-start.mjs`、
 * `servers/user-prompt-submit.mjs`），`system-reminder` 是宿主写给模型的带外提示。
 * 加第四个之前先确认它真的会出现在 transcript 里——多一条规则就多一类误伤。
 *
 * @type {readonly string[]}
 */
const BLOCK_TAGS = Object.freeze([
  'comem-recall',
  'comem-profile',
  'comem-preferences',
  'system-reminder',
]);

/**
 * 行首时间戳：`[2024-01-01T00:00:00Z]`、`[2024-01-01 00:00:00+08:00]`。
 *
 * 日期部分必须是 `\d{4}-\d{2}-\d{2}T`（架构文档 §15.10 的口径），紧跟的
 * `[^\]]*` 不嵌套、不会回溯。`m` 让 `^` 认每一行的行首。
 */
const LEADING_TIMESTAMP = /^[ \t]*\[\d{4}-\d{2}-\d{2}T[^\]]*\][ \t]*/gm;

/**
 * 裸 epoch：10 位（秒）与 13 位（毫秒），只认 `16`–`19` 开头。
 *
 * 取值范围是「2016 年–2033 年」：再往前的时间戳不是会话消息，收窄能少吃掉
 * 正常的十位数。`\b` 保证不会切在更长的数字中间。
 *
 * **只在块剥完之后作用**——见文件头第 3 条。
 */
const BARE_EPOCH = /\b1[6-9]\d{8}\b|\b1[6-9]\d{11}\b/g;

/** 连续 3 个以上换行。剥掉块之后留下的空行收成一段。 */
const BLANK_LINE_RUN = /\n{3,}/g;

/**
 * 剥掉一种标签的所有块。返回 `{ text, removed }`——`removed` 只用于决定要不要收
 * 空行，不影响内容。
 *
 * @param {string} text
 * @param {string} tag
 * @returns {{ text: string, removed: boolean }}
 */
function stripTagBlocks(text, tag) {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  let cursor = 0;
  let kept = '';
  let removed = false;

  for (;;) {
    const start = text.indexOf(open, cursor);
    if (start < 0) {
      return { text: kept + text.slice(cursor), removed };
    }
    kept += text.slice(cursor, start);
    removed = true;
    const end = text.indexOf(close, start + open.length);
    if (end < 0) {
      // 开标签没有闭标签：吃到末尾。留半截块会被当成用户的话。
      return { text: kept, removed };
    }
    cursor = end + close.length;
  }
}

/**
 * 清掉块与块嵌套时留下的孤立标签（`<comem-recall><comem-recall>x</comem-recall>`
 * 剥完剩 `</comem-recall>`）。
 *
 * 目标不是「能删」，是**剥完的文本里不再有 CoMem 的块标签**：留下的半截标签会被
 * 抽取器当成一条奇怪的记忆，也可能在写回画像之后继续传播。
 *
 * @param {string} text
 * @returns {{ text: string, removed: boolean }}
 */
function stripStrayTags(text) {
  let value = text;
  let removed = false;
  for (const tag of BLOCK_TAGS) {
    const open = `<${tag}>`;
    const close = `</${tag}>`;
    if (!value.includes(open) && !value.includes(close)) {
      continue;
    }
    value = value.replaceAll(open, '').replaceAll(close, '');
    removed = true;
  }
  return { text: value, removed };
}

/**
 * 剥掉一条消息文本里的注入块、行首时间戳与裸 epoch。
 *
 * 返回的文本已 `trim()`；**空串表示这条消息没有剩下任何内容**，调用方应当整条
 * 丢弃，而不是把空串发给服务端（服务端会把空消息当成一轮对话）。
 *
 * @param {string} text
 * @returns {string}
 */
export function sanitizeCapturedText(text) {
  let value = typeof text === 'string' ? text : String(text ?? '');
  let removed = false;

  for (const tag of BLOCK_TAGS) {
    const stripped = stripTagBlocks(value, tag);
    value = stripped.text;
    removed = removed || stripped.removed;
  }
  const stray = stripStrayTags(value);
  value = stray.text;
  removed = removed || stray.removed;

  // 顺序见文件头：块 → 行首时间戳 → 裸 epoch。
  value = value.replace(LEADING_TIMESTAMP, '');
  value = value.replace(BARE_EPOCH, '');
  if (removed) {
    // 只在我们真的删过东西时收空行：没删过就不该改动用户写的空行。
    value = value.replace(BLANK_LINE_RUN, '\n\n');
  }
  return value.trim();
}

/**
 * 对整份消息列表做剥离：**逐条**处理 `parts` 里的文本，整条变空的消息丢弃。
 *
 * 消息形状是 `hosts/*.mjs` 的 `parseTranscript` / `normalizeMessages` 的产物
 * （`{ id, role, parts: [{ kind: 'text', text }], createdAt }`）。非文本 part 原样
 * 保留——它们由各自的 hook 采集，与注入块无关。
 *
 * **返回的是新数组，不修改入参**：`captureSession` 里的 `messages` 还用于
 * 「解析出几条」的诊断，两边不能互相污染。
 *
 * @param {readonly { parts?: readonly { kind?: string, text?: string }[] }[]} messages
 * @returns {Record<string, unknown>[]}
 */
export function sanitizeCapturedMessages(messages) {
  const sanitized = [];
  for (const message of messages) {
    const parts = [];
    for (const part of message.parts ?? []) {
      if (part.kind !== 'text' || typeof part.text !== 'string') {
        parts.push(part);
        continue;
      }
      const text = sanitizeCapturedText(part.text);
      if (text === '') {
        continue;
      }
      parts.push({ ...part, text });
    }
    // 一条消息的所有文本 part 都被剥空 = 这条消息只由注入块组成。整条丢掉，
    // 不要发一条空消息给服务端。
    if (parts.length === 0) {
      continue;
    }
    sanitized.push({ ...message, parts });
  }
  return sanitized;
}
