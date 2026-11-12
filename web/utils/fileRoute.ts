/**
 * `comem://` URI → 控制台文件树路由。
 *
 * 两处需要「新建后跳到那条文件」：概览页（创建成功直接进文件详情）与文件树页
 * （选中新建的节点）。编码规则只在这里一份：URI 里的段逐个 `encodeURIComponent`，
 * 否则段内的 `#`、`?`、空格会被浏览器当成 URL 语法。
 *
 * 这不是路径规则——路径由服务端算，响应里给的就是最终 URI，这里只把它变成站内链接。
 */
const URI_PREFIX = 'comem://'

export function fileRouteOf(uri: string): string {
  const relative = uri.startsWith(URI_PREFIX) ? uri.slice(URI_PREFIX.length) : uri
  const encoded = relative
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return `/files/${encoded}`
}
