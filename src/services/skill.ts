/**
 * 技能安装（架构文档 §6.5、§11.1、§13）。
 *
 * 一个技能是 `skills/{name}/` 下的文件树，入口固定为根目录的 `SKILL.md`。安装
 * 走与 `add_resource` 相同的批量路径（§10.6）：全部文件写完后**一次**
 * `index.upsert`，再按父目录去重投递摘要失效。摘要标记与写后物化权限的规则在
 * `write-through.ts`，与 `ResourceService` 共用一份实现。
 *
 * ## 校验
 *
 * 技能包没有入口文件等于没装，所以 `SKILL.md` 缺失直接 `INVALID_ARGUMENT`。
 * `SKILL.md` 的 frontmatter 至少要有 `name` 与 `description`：前者是技能标识，
 * 后者是检索与展示用的说明，缺任一个都装不出可用的技能。
 *
 * ## 可执行位
 *
 * `SkillFileInput.executable` 字段保留，但**不设置**：`services/` 不能 import
 * `node:fs`（§4.2），`ContentStore` 也没有 chmod 能力。等 `adapters/` 增加一个
 * 显式的权限设置入口再落地；静默忽略比伪造一个不存在的保证更诚实。
 */

import type { ContentStore, StoredStat } from '../adapters/fs/content-store.js';
import type { PathLockManager } from '../adapters/fs/lock.js';
import type { PermissionRepository } from '../adapters/sqlite/permission-repository.js';
import { ComemError } from '../domain/errors.js';
import type { Logger } from '../domain/log.js';
import { stableDigest } from '../domain/node.js';
import type { IndexRecord, RetrievalIndex } from '../domain/retrieval.js';
import type { Uri } from '../domain/uri.js';

import type { SummaryService } from './summary.js';
import type { Authorizer } from './authorizer.js';
import { invalidateParentSummaries, materializeAncestorPermissions } from './write-through.js';

/** 技能入口文件名。 */
const SKILL_ENTRY_FILE = 'SKILL.md';

/**
 * 技能名：小写字母、数字、短横线，且以字母或数字开头。
 *
 * 短横线不能在开头是为了和 CLI 参数、保留前缀区分；这个字符集同时排除了路径
 * 分隔符、`.`、`_` 与全部元数据保留名（`.abstract.md`、`memory_diff.json` 等），
 * 所以不需要再单独维护一份保留名集合（两份集合必然漂移）。
 */
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** 技能文件的索引层级：原文件是 L2（L0 / L1 是目录摘要，§9.1）。 */
const SKILL_LEVEL = 'L2';

export interface SkillFileInput {
  /** 相对技能根目录的路径，如 `SKILL.md` 或 `scripts/check.sh` */
  readonly path: string;
  readonly content: Uint8Array;
  /** 可执行权限（见文件头「可执行位」：当前不设置） */
  readonly executable?: boolean;
}

export interface AddSkillOptions {
  /** 技能目录的父目录，如 `comem://user/alice/skills` */
  readonly parentUri: Uri;
  /** 技能名，作为目录名。只允许小写字母、数字、短横线 */
  readonly name: string;
  readonly files: readonly SkillFileInput[];
  readonly subject: string;
  readonly principals: readonly string[];
}

export interface AddSkillResult {
  readonly skillUri: Uri;
  readonly fileCount: number;
}

export interface SkillServiceDeps {
  readonly store: ContentStore;
  readonly locks: PathLockManager;
  readonly index: RetrievalIndex;
  readonly summary: Pick<SummaryService, 'markStale'>;
  /** 权限反查走物化表（§8.2）：`principals` 来自调用方身份，不重新展开组。 */
  readonly permissions: Pick<PermissionRepository, 'readableUris'>;
  /**
   * 写后物化权限（§12.4）。
   *
   * 技能文件直接写 `ContentStore`，不经过 `FileSystemService` 的观察者。不物化的话
   * `node_permission` 里没有技能目录的行，而 `listSkills` 的过滤是纯 SQL 查询——
   * 装好的技能在控制台里整个消失。
   */
  readonly authorizer: Authorizer;
  readonly logger: Logger;
}

/** 解析后的技能文件：URI 已校验，正文已解码。 */
interface ResolvedSkillFile {
  readonly uri: Uri;
  readonly content: Uint8Array;
  readonly text: string;
  /** 是否是根目录的 `SKILL.md` */
  readonly isEntry: boolean;
}

function invalidArgument(message: string, details: Record<string, unknown>): ComemError {
  return new ComemError('INVALID_ARGUMENT', message, details);
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return '';
  }
}

/** 去掉成对的单引号或双引号；YAML 的引用形式在技能文件里只用到这一种。 */
function unquote(value: string): string {
  if (value.length < 2) {
    return value;
  }
  const first = value[0];
  const last = value.at(-1);
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * 读 `SKILL.md` 的 frontmatter，校验 `name` 与 `description`。
 *
 * 只支持「`---` 包起来、每行 `key: value`」这一个子集：技能包的 frontmatter 是
 * 我们自己定义的，不需要完整 YAML 解析器（`services/` 也不能值 import 适配层的
 * 编解码实现）。
 */
function requireSkillFrontmatter(text: string, skillUri: Uri): { readonly description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const body = match?.[1];
  if (body === undefined) {
    throw invalidArgument(`${SKILL_ENTRY_FILE} 缺少 frontmatter：${skillUri.toString()}。`, {
      uri: skillUri.toString(),
    });
  }

  const fields = new Map<string, string>();
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const separator = trimmed.indexOf(':');
    if (separator <= 0) {
      continue;
    }
    fields.set(trimmed.slice(0, separator).trim(), unquote(trimmed.slice(separator + 1).trim()));
  }

  const name = fields.get('name');
  if (name === undefined || name === '') {
    throw invalidArgument(`${SKILL_ENTRY_FILE} 的 frontmatter 缺少 name：${skillUri.toString()}。`, {
      uri: skillUri.toString(),
      field: 'name',
    });
  }
  const description = fields.get('description');
  if (description === undefined || description === '') {
    throw invalidArgument(
      `${SKILL_ENTRY_FILE} 的 frontmatter 缺少 description：${skillUri.toString()}。`,
      { uri: skillUri.toString(), field: 'description' },
    );
  }
  return { description };
}

function assertSkillName(name: string): void {
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw invalidArgument(
      `技能名不合法：${name}。只允许小写字母、数字与短横线，且必须以字母或数字开头。`,
      { name },
    );
  }
}

export class SkillService {
  readonly #store: ContentStore;
  readonly #locks: PathLockManager;
  readonly #index: RetrievalIndex;
  readonly #summary: Pick<SummaryService, 'markStale'>;
  readonly #permissions: Pick<PermissionRepository, 'readableUris'>;
  readonly #authorizer: Authorizer;
  readonly #logger: Logger;

  constructor(deps: SkillServiceDeps) {
    this.#store = deps.store;
    this.#locks = deps.locks;
    this.#index = deps.index;
    this.#summary = deps.summary;
    this.#permissions = deps.permissions;
    this.#authorizer = deps.authorizer;
    this.#logger = deps.logger;
  }

  /**
   * 安装一个技能。
   *
   * 全部路径先在锁外校验（不碰磁盘），再在技能目录的 `TREE` 锁里写文件、批量
   * 写索引。锁释放后投递摘要失效——`SummaryService` 会拿目录的 `EXACT` 锁，和
   * 本服务的 `TREE` 锁互斥，必须在锁外调（§10.6）。
   */
  async addSkill(options: AddSkillOptions): Promise<AddSkillResult> {
    assertSkillName(options.name);
    const skillUri = options.parentUri.child(options.name);
    const files = resolveSkillFiles(skillUri, options.files);
    const entry = files.find((file) => file.isEntry);
    if (entry === undefined) {
      throw invalidArgument(
        `技能 ${options.name} 缺少入口文件 ${SKILL_ENTRY_FILE}。`,
        { name: options.name, uri: skillUri.toString() },
      );
    }
    const { description } = requireSkillFrontmatter(entry.text, skillUri);

    const records: IndexRecord[] = [];
    const written: Uri[] = [];

    await this.#locks.withLock(skillUri, 'tree', async () => {
      for (const file of files) {
        const stat = await this.#store.writeBytes(file.uri, file.content);
        records.push({
          uri: file.uri.toString(),
          parentUri: file.uri.parent()?.toString() ?? '',
          scope: file.uri.scope,
          kind: 'document',
          contextType: 'skill',
          memoryType: null,
          level: SKILL_LEVEL,
          // 入口文件的 description 就是技能的一句话摘要；其余文件没有摘要。
          abstract: file.isEntry ? description : null,
          content: file.text,
          bodyDigest: stableDigest(file.text),
          size: file.content.byteLength,
          updatedAt: stat.updatedAt,
          status: 'active',
        });
        written.push(file.uri);
      }

      await this.#index.upsert(records);
      // §12.4 的「写时算」：技能文件不经过 `FileSystemService`，观察者收不到通知。
      // 一起物化技能根目录——`listSkills` 列的就是它，缺行等于技能不存在。
      await materializeAncestorPermissions(
        { authorizer: this.#authorizer, logger: this.#logger, nodeLabel: '技能节点' },
        [skillUri, ...written],
        options.principals,
      );
    });

    await invalidateParentSummaries({ summary: this.#summary, logger: this.#logger }, written);

    this.#logger.info('技能已安装', {
      skill: skillUri.toString(),
      subject: options.subject,
      principalCount: options.principals.length,
      files: records.length,
    });

    return { skillUri, fileCount: records.length };
  }

  /**
   * 列出某个 scope 下的技能。
   *
   * `scopeUri` 是作用域根（`comem://user/alice` 或 `comem://group/eng`），技能目录
   * 固定在它的 `skills/` 下。只返回调用方有 read 权限的目录——无权限的技能连名字
   * 都不出现（§12.4 的列表语义）。
   */
  async listSkills(
    scopeUri: Uri,
    options: { readonly subject: string; readonly principals: readonly string[] },
  ): Promise<readonly Uri[]> {
    const skillsUri = scopeUri.child('skills');
    let entries: readonly StoredStat[];
    try {
      entries = await this.#store.list(skillsUri);
    } catch (error) {
      if (error instanceof ComemError && error.code === 'NOT_FOUND') {
        // 还没装过任何技能：空列表，不是错误。
        return [];
      }
      throw error;
    }

    const candidates = entries
      .filter((entry) => entry.kind === 'directory')
      .map((entry) => entry.uri);
    const readable = this.#permissions.readableUris(
      candidates.map((uri) => uri.toString()),
      options.principals,
    );

    this.#logger.debug('技能列表', {
      scope: scopeUri.toString(),
      subject: options.subject,
      total: candidates.length,
      visible: readable.size,
    });
    return candidates.filter((uri) => readable.has(uri.toString()));
  }
}

/** 逐段校验技能内路径；同一路径重复出现时后者覆盖前者。 */
function resolveSkillFiles(
  skillUri: Uri,
  files: readonly SkillFileInput[],
): readonly ResolvedSkillFile[] {
  const byPath = new Map<string, ResolvedSkillFile>();
  for (const file of files) {
    let uri: Uri;
    try {
      uri = skillUri.child(...file.path.split('/'));
    } catch (error) {
      throw invalidArgument(
        `技能文件路径不合法：${file.path}。`,
        { path: file.path, reason: error instanceof Error ? error.message : String(error) },
      );
    }
    byPath.set(file.path, {
      uri,
      content: file.content,
      text: decodeText(file.content),
      isEntry: uri.parent()?.equals(skillUri) === true && uri.name === SKILL_ENTRY_FILE,
    });
  }
  return [...byPath.values()];
}
