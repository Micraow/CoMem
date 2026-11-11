/**
 * 网络地址判定（架构文档 §18 的 `server.host`、§12.7 的引导端点）。
 *
 * 放在 `domain/` 是因为它只做字符串判定、没有 IO，也不 import `node:net`：
 * 配置校验与请求处理两条路径必须用同一份判据，各写一份必然漂移。
 *
 * **`0.0.0.0` 与 `::` 不是回环。** 它们监听所有接口；把它们当回环等于
 * 「单用户模式对全网开放」，正是 `auth.enabled: false` 的启动守卫要挡掉的那一类。
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
