/**
 * 网络地址判定（架构文档 §18 的 `server.host`、§12.7 的回环信任）。
 *
 * 放在 `domain/` 是因为它只做字符串判定、没有 IO，也不 import `node:net`：
 * 配置校验与请求处理两条路径必须用同一份判据，各写一份必然漂移。
 *
 * **`0.0.0.0` 与 `::` 不是回环。** 它们监听所有接口；把它们当回环等于
 * 「把任何能连上端口的人都当成 `server.subject`」，正是 `auth.trustLoopback`
 * 的启动守卫要挡掉的那一类。
 */

/** 只在本机可达的监听 / 来源地址：`127.0.0.0/8`、`::1`、`localhost`（含 IPv4 映射）。 */
export function isLoopbackAddress(address: string): boolean {
  const value = address.trim().toLowerCase();
  if (value === '' || value === 'localhost' || value === '::1') {
    return value !== '';
  }
  // `::ffff:127.0.0.1` 是双栈监听下 Node 报告的 IPv4 来源；按 IPv4 判。
  const normalized = value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value;
  const octets = normalized.split('.');
  if (octets.length !== 4) {
    return false;
  }
  return octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255) &&
    octets[0] === '127';
}

/**
 * `Host` 请求头是否指向本机。
 *
 * 回环信任不能只看 `socket.remoteAddress`：DNS rebinding 让一个远程页面用自己
 * 的域名解析到 `127.0.0.1`，浏览器发出的连接来源就是回环地址。`Host` 由浏览器
 * 按地址栏填，非本机域名在这里返回 `false`，攻击页面因此拿不到绑定主体。
 *
 * 入参是完整头（`127.0.0.1:1933`、`[::1]:1933`、`localhost`），端口与 IPv6
 * 方括号在这里剥掉。空值 / 缺失一律不算本机——HTTP/1.0 没有 `Host`，那种请求
 * 没有可校验的来源名。
 */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (host === undefined) {
    return false;
  }
  const value = host.trim().toLowerCase();
  if (value === '') {
    return false;
  }
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 1 && isLoopbackAddress(value.slice(1, end));
  }
  const separator = value.indexOf(':');
  return isLoopbackAddress(separator < 0 ? value : value.slice(0, separator));
}
