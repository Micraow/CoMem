/**
 * 记忆正文的显示形态（记忆复核页的差异左栏）。
 *
 * 存储层把记忆正文放在 `## content` 标题下（`src/services/memory.ts` 的
 * `renderBody`：`## content\n\n` + 正文）。标题是存储细节，不是记忆内容，
 * 差异视图只比较正文。
 *
 * ## 剥法与后端的 `extractContent()` 同一语义
 *
 * 服务端读回正文时（`src/services/memory.ts` 的 `extractContent`：先匹配
 * `## content\n`，再剥掉紧随其后的**一个** `\n`）——第二个 `\n` 是 `renderBody`
 * 写的空行；正文本身以空行开头时，额外的换行属于正文。这里逐字节照做。
 *
 * 旧实现用 `replace(/^\n+/, '')` 删掉全部前导换行：磁盘上
 * `## content\n\n\n\n步骤…` 的正文是 `\n\n步骤…`，左栏却显示成 `步骤…`，而右栏
 * （复核记录里的 `fields.content`）是 `\n\n步骤…`——复核页因此显示出一处并不存在
 * 的差异。
 *
 * ## 为什么这里不剥 frontmatter
 *
 * `GET /content/read` 返回的是 `ContentStore.readText` 的 `document.body`
 * （`src/adapters/fs/content-store.ts:176-193`）：frontmatter 在适配层已经剥掉，
 * 响应里不会出现 `---` 块。复核队列里的记录又都经过 `parseMemoryDocument`
 * 校验（没有可解析 frontmatter 的文件进不了队列），所以这一步的输入只有正文。
 * 别为「某些旧文件可能带 frontmatter」在这里加第二个解析器——这条路径到不了这里。
 */
const CONTENT_HEADING = '## content'

/**
 * 去掉正文前的存储层标题。
 *
 * 与 `extractContent()` 的分支一一对应：
 * - 正文不以 `## content\n` 开头时原样返回（服务端同样认为没有 `content` 字段）；
 * - 命中时剥掉标题行，再剥掉紧随其后的一个 `\n`，其余字节原样保留。
 *
 * CRLF 的 `## content\r\n` 不命中前缀，整段原样返回：`renderBody` 只写 LF，而
 * `extractContent()` 也只认 LF 标题行——这里不发明第三套换行语义。
 */
export function memoryBodyText(text: string): string {
  const prefix = `${CONTENT_HEADING}\n`
  if (!text.startsWith(prefix)) {
    return text
  }
  const rest = text.slice(prefix.length)
  return rest.startsWith('\n') ? rest.slice(1) : rest
}
