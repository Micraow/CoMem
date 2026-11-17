/**
 * 从宿主当前目录解析稳定的 CoMem 项目 ID。
 *
 * 顺序固定：最近祖先 `.comem/config.json` → git root 的 `origin` → 无 origin git
 * root 的 realpath。没有显式配置也没有 git 时返回 `undefined`，因此普通 HOME
 * 对话不会被当成一个项目。
 *
 * 远程身份只用于本地算哈希和短标签，绝不发送 remote、commit URL 或绝对路径。
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 1500;
const GIT_MAX_BUFFER = 16 * 1024;
const MAX_SEGMENT_BYTES = 255;
const REMOTE_HASH_LENGTH = 16;
const PATH_HASH_LENGTH = 16;
const RESERVED_SEGMENT_NAMES = new Set([
  '.abstract.md', '.overview.md', '.acl.json', '.meta.json', '.done',
  'memory_diff.json', 'memory_operations.json',
]);

export class ProjectResolutionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProjectResolutionError';
    this.code = 'PROJECT_CONFIG_INVALID';
  }
}

function containsForbiddenCharacter(value) {
  return value.includes('\\')
    || [...value].some((character) => character.codePointAt(0) < 0x20);
}

/** 与 `Uri.child` 的单段规则一致；非法显式 ID 返回 `null`。 */
export function normalizeExplicitProjectId(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.normalize('NFC');
  if (
    normalized === ''
    || normalized === '.'
    || normalized === '..'
    || normalized.includes('/')
    || containsForbiddenCharacter(normalized)
    || RESERVED_SEGMENT_NAMES.has(normalized)
    || Buffer.byteLength(normalized, 'utf8') > MAX_SEGMENT_BYTES
  ) {
    return null;
  }
  return normalized;
}

function parsedConfigProjectId(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  if (value.version !== 1 || typeof value.project !== 'object' || value.project === null) {
    return null;
  }
  return normalizeExplicitProjectId(value.project.id);
}

function defaultPortFor(scheme) {
  switch (scheme) {
    case 'http': return '80';
    case 'https': return '443';
    case 'ssh': return '22';
    case 'git': return '9418';
    default: return '';
  }
}

function cleanRemotePath(value) {
  let path = value.replace(/^\/+|\/+$/g, '');
  path = path.replace(/\.git$/i, '');
  return path.split('/').filter((part) => part !== '').join('/').toLowerCase();
}

/**
 * 把 HTTPS、SSH 与 SCP 形式归一为不含凭据、query、fragment 或 `.git` 的身份。
 *
 * 返回的 canonical 值只留在解析进程内。无法安全识别的 remote 返回 `null`。
 */
export function normalizeRemoteIdentity(remote) {
  if (typeof remote !== 'string' || remote.trim() === '') {
    return null;
  }
  const input = remote.trim();
  const scp = /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(input);
  if (!input.includes('://') && scp !== null) {
    const host = scp[1].toLowerCase();
    const path = cleanRemotePath(scp[2].replace(/[?#].*$/, ''));
    return host !== '' && path !== '' ? `${host}/${path}` : null;
  }

  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }
  const scheme = parsed.protocol.endsWith(':') ? parsed.protocol.slice(0, -1) : parsed.protocol;
  if (!['http', 'https', 'ssh', 'git'].includes(scheme)) {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const path = cleanRemotePath(parsed.pathname);
  if (host === '' || path === '') {
    return null;
  }
  const port = parsed.port !== '' && parsed.port !== defaultPortFor(scheme) ? `:${parsed.port}` : '';
  return `${host}${port}/${path}`;
}

function digest(value, length) {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function readableSlug(value) {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

/** 远程项目 ID：可读 host/path 标签 + canonical 身份的短哈希。 */
export function projectIdFromRemoteIdentity(identity) {
  if (typeof identity !== 'string' || identity === '') {
    return null;
  }
  const suffix = `-${digest(identity, REMOTE_HASH_LENGTH)}`;
  const prefix = 'remote-';
  const fixedBytes = Buffer.byteLength(prefix + suffix, 'utf8');
  let label = readableSlug(identity);
  while (Buffer.byteLength(label, 'utf8') > MAX_SEGMENT_BYTES - fixedBytes) {
    label = label.slice(0, -1);
  }
  return `${prefix}${label}${suffix}`;
}

/** git 无 origin 时只暴露真实 root 路径的哈希，不把路径作为 ID。 */
export function projectIdFromGitRoot(realGitRoot) {
  return `root-${digest(realGitRoot, PATH_HASH_LENGTH)}`;
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function explicitProjectAtOrAbove(cwd) {
  let current = cwd;
  for (;;) {
    const configPath = join(current, '.comem', 'config.json');
    let text;
    try {
      text = await readFile(configPath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
        throw new ProjectResolutionError('显式项目配置无法读取。');
      }
    }
    if (text !== undefined) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ProjectResolutionError('显式项目配置不是合法 JSON。');
      }
      if (
        typeof parsed !== 'object'
        || parsed === null
        || Array.isArray(parsed)
        || parsed.version !== 1
        || typeof parsed.project !== 'object'
        || parsed.project === null
      ) {
        throw new ProjectResolutionError(
          '显式项目配置必须包含 version: 1 与 project.id。',
        );
      }
      const projectId = parsedConfigProjectId(parsed);
      if (projectId === null) {
        throw new ProjectResolutionError('显式项目配置的 project.id 不是合法路径段。');
      }
      return { found: true, projectId };
    }
    const parent = dirname(current);
    if (parent === current) {
      return { found: false, projectId: null };
    }
    current = parent;
  }
}

async function gitOutput(cwd, args) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', cwd, ...args],
      {
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
      },
    );
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * 返回适合发给服务端的单段 `projectId`；无项目时返回 `undefined`。
 *
 * 最近配置存在但内容/`project.id` 非法时抛无敏感值的
 * {@link ProjectResolutionError}，不会回退 git，也不会静默改成个人空间。
 */
export async function resolveProjectId(cwd) {
  if (typeof cwd !== 'string' || cwd === '') {
    return undefined;
  }
  const absolute = resolve(cwd);
  if (!(await isDirectory(absolute))) {
    return undefined;
  }
  const realCwd = await realpath(absolute).catch(() => null);
  if (realCwd === null) {
    return undefined;
  }

  const explicit = await explicitProjectAtOrAbove(realCwd);
  if (explicit.found) {
    return explicit.projectId ?? undefined;
  }

  const root = await gitOutput(realCwd, ['rev-parse', '--show-toplevel']);
  if (root === null || root === '') {
    return undefined;
  }
  const realRoot = await realpath(root).catch(() => null);
  if (realRoot === null) {
    return undefined;
  }
  const origin = await gitOutput(realRoot, ['remote', 'get-url', 'origin']);
  const identity = normalizeRemoteIdentity(origin);
  return identity === null ? projectIdFromGitRoot(realRoot) : projectIdFromRemoteIdentity(identity);
}

/** 请求体的可选字段：未解析到项目时完全省略 `projectId`。 */
export function withProjectId(projectId) {
  if (projectId === undefined) {
    return {};
  }
  return { projectId };
}
