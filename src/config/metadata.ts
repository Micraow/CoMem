/**
 * 配置端点的只读视图（架构文档 §18）。
 *
 * 把「84 个叶子」翻译成控制台能直接渲染的列表：来源、环境变量名、分组、是否可写，
 * 以及**脱敏**。密钥类只回 `configured` + 末 4 位掩码，明文永不出现在响应里
 * （与 `admin-api-keys.ts` 的密钥纪律同一条）。
 *
 * 审计确认不能暴露的值（数据根、认证边界、监听地址、本机路径、任务队列参数）除了
 * `editable: false` 还要把 `value` 置空——只靠 `editable` 是「看起来不可写」，值
 * 本身仍然在响应里。
 */

import type { ConfigSnapshot, ConfigSource } from './index.js';
import { collectLeaves, envNameFor, getPath } from './merge.js';

export type ConfigGroup =
  | 'llm'
  | 'embedding'
  | 'rerank'
  | 'retrieval'
  | 'memory'
  | 'session'
  | 'task'
  | 'telemetry'
  | 'server'
  | 'auth'
  | 'ingest'
  | 'logging'
  | 'summary'
  | 'acl';

export interface ConfigLeafView {
  readonly path: string;
  /** 密钥类与不可暴露项为 `null`。 */
  readonly value: unknown;
  readonly source: ConfigSource;
  readonly secret: boolean;
  /** 仅密钥类有意义：值非空即已设置。 */
  readonly configured: boolean;
  /** 仅密钥类：`****abcd`（末 4 位）；未设置为 `null`。 */
  readonly masked: string | null;
  readonly envName: string;
  readonly editable: boolean;
  readonly group: ConfigGroup;
  /** 不可写 / 不可暴露的原因；可编辑项没有这个字段。 */
  readonly reason?: string;
}

export interface ConfigView {
  readonly overridePath: string;
  readonly overrideWritable: boolean;
  readonly items: readonly ConfigLeafView[];
}

/** 密钥：响应里只出现 `configured` 与末 4 位。 */
const SECRET_PATHS: ReadonlySet<string> = new Set([
  'providers.llm.default.apiKey',
  'providers.embedding.apiKey',
  'providers.rerank.apiKey',
  'auth.sessionSecret',
]);

/** 不能出现在响应里的值。键是原因，输出时 `value` 置 `null`。 */
const NON_EXPOSABLE: ReadonlyMap<string, string> = new Map([
  ['dataDir', '换它等于换库：它决定数据根与覆盖文件本身的位置'],
  ['auth.sessionSecret', 'session 签名密钥，明文永不出现在任何响应里'],
  ['auth.adminUserIds', '系统管理员名单，暴露等于给出提权目标'],
  ['auth.trustLoopback', '认证边界：暴露它等于说明哪些不带凭据的请求会被信任'],
  ['server.host', '监听地址，属于部署拓扑'],
  ['server.port', '监听端口，属于部署拓扑'],
  ['logging.file', '服务器文件系统路径'],
  ['ingest.paths.claude-code', '本机文件系统路径'],
  ['ingest.paths.codex', '本机文件系统路径'],
  ['ingest.paths.deepseek', '本机文件系统路径'],
  ['ingest.paths.qwen', '本机文件系统路径'],
  ['task.leaseSeconds', '任务队列内部调度参数'],
  ['task.maxAttempts', '任务队列内部调度参数'],
  ['task.concurrency', '任务队列内部调度参数'],
]);

/**
 * 值可以暴露、但暂不开放写入的项。
 *
 * `retrieval.queryFilters` 是 sed 风格正则，schema 只校验「字符串数组」；写进一个
 * 非法正则要等到检索时才抛错。先不开放，等有正则预编译校验再加。
 */
const NON_EDITABLE: ReadonlyMap<string, string> = new Map([
  ['retrieval.queryFilters', '正则只做字符串校验，非法值会等到检索时才报错；先不开放写入'],
]);

function groupOf(path: string): ConfigGroup {
  const [head, second] = path.split('.');
  if (head === 'providers') {
    if (second === 'llm') {
      return 'llm';
    }
    if (second === 'embedding') {
      return 'embedding';
    }
    return 'rerank';
  }
  // `dataDir` 是部署级设置，归到 server 分组；它没有自己的分组。
  if (head === 'dataDir') {
    return 'server';
  }
  return head as ConfigGroup;
}

/** 末 4 位；短密钥整串都被掩码覆盖，不泄露长度信息之外的字符。 */
function maskSecret(secret: string): string | null {
  if (secret === '') {
    return null;
  }
  return `****${secret.slice(-4)}`;
}

function editableReason(path: string, secret: boolean): string | null {
  if (secret) {
    // `auth.sessionSecret` 既在 SECRET_PATHS 也在 NON_EXPOSABLE；apiKey 不在后者。
    return NON_EXPOSABLE.get(path) ?? null;
  }
  return NON_EXPOSABLE.get(path) ?? NON_EDITABLE.get(path) ?? null;
}

/** 构造 `GET /config` 的响应体。`overrideWritable` 由路由传 `fs.access` 的结果。 */
export function describeConfig(
  snapshot: ConfigSnapshot,
  overrideWritable: boolean,
): ConfigView {
  const items = collectLeaves(snapshot.defaults).map((leaf): ConfigLeafView => {
    const path = leaf.path.join('.');
    const secret = SECRET_PATHS.has(path);
    const reason = editableReason(path, secret);
    const hidden = NON_EXPOSABLE.has(path);
    const raw = getPath(snapshot.config, leaf.path);
    return {
      path,
      value: secret || hidden ? null : raw,
      source: snapshot.sources.get(path) ?? 'default',
      secret,
      configured: secret && typeof raw === 'string' && raw !== '',
      masked: secret && typeof raw === 'string' ? maskSecret(raw) : null,
      envName: envNameFor(leaf.path),
      editable: reason === null,
      group: groupOf(path),
      ...(reason === null ? {} : { reason }),
    };
  });
  return { overridePath: snapshot.overridePath, overrideWritable, items };
}
