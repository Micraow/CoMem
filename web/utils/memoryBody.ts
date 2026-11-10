/**
 * 记忆正文的显示形态（记忆复核页的差异左栏）。
 *
 * 存储层把记忆正文放在 `## content` 标题下（`src/services/memory.ts` 的
 * `renderBody`：`## content\n\n` + 正文）。标题是存储细节，不是记忆内容，
 * 差异视图只比较正文。
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
 * 行为与迁移前 `web/pages/review.vue` 里的局部实现逐字节一致：不命中 `## content`
 * 前缀时原样返回；命中时删掉前缀与紧随其后的换行。`\r\n` 不在 `^\n+` 的范围内，
 * CRLF 正文会保留分隔符后的 `\r\n`，本次不改这条语义。
 */
export function memoryBodyText(text: string): string {
  if (!text.startsWith(CONTENT_HEADING)) {
    return text
  }
  return text.slice(CONTENT_HEADING.length).replace(/^\n+/, '')
}
