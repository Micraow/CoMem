import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import { createPathLockManager, type PathLockManager } from '../../../src/adapters/fs/lock.js';
import type { AclAction } from '../../../src/services/authorizer.js';
import {
  AllowAllAuthorizer,
  permissionDenied,
  type Authorizer,
} from '../../../src/services/authorizer.js';
import { FileSystemService, type NodeWriteObserver } from '../../../src/services/filesystem.js';
import type { Logger } from '../../../src/domain/log.js';
import { Uri } from '../../../src/domain/uri.js';

const AUTH_PRINCIPALS: readonly string[] = [];

interface RecordingLogger extends Logger {
  readonly warnings: string[];
  readonly errors: string[];
}

function createLogger(): RecordingLogger {
  const warnings: string[] = [];
  const errors: string[] = [];
  const logger: RecordingLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message) => {
      warnings.push(message);
    },
    error: (message) => {
      errors.push(message);
    },
    warnings,
    errors,
  };
  return logger;
}

/** 记录通知顺序的观察者。 */
class RecordingObserver implements NodeWriteObserver {
  readonly written: { readonly uri: string; readonly kind: 'file' | 'directory' }[] = [];
  readonly removed: string[] = [];
  readonly moved: { readonly from: string; readonly to: string }[] = [];

  async onNodeWritten(uri: Uri, kind: 'file' | 'directory'): Promise<void> {
    this.written.push({ uri: uri.toString(), kind });
  }

  async onNodeRemoved(uri: Uri): Promise<void> {
    this.removed.push(uri.toString());
  }

  async onNodeMoved(from: Uri, to: Uri): Promise<void> {
    this.moved.push({ from: from.toString(), to: to.toString() });
  }
}

/** 拒绝特定 URI 的测试替身，用来断言列表语义（§12.4）。 */
class DenyAuthorizer implements Authorizer {
  readonly #denied: ReadonlySet<string>;

  constructor(denied: readonly Uri[]) {
    this.#denied = new Set(denied.map((uri) => uri.toString()));
  }

  async check(uri: Uri): Promise<boolean> {
    return !this.#denied.has(uri.toString());
  }

  async filterReadable(uris: readonly Uri[]): Promise<ReadonlySet<string>> {
    return new Set(
      uris.map((uri) => uri.toString()).filter((uri) => !this.#denied.has(uri)),
    );
  }

  async assert(uri: Uri, action: AclAction): Promise<void> {
    if (this.#denied.has(uri.toString())) {
      throw permissionDenied(uri, action);
    }
  }
}

const BASE = 'comem://user/alice/memories';

function uri(path: string): Uri {
  return Uri.parse(`${BASE}/${path}`);
}

let tempDir: string;
let logger: RecordingLogger;
let store: ContentStore;
let locks: PathLockManager;
let service: FileSystemService;

function createService(
  authorizer: Authorizer = new AllowAllAuthorizer(),
  observers: readonly NodeWriteObserver[] = [],
): FileSystemService {
  return new FileSystemService({ store, locks, authorizer, logger, observers });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'comem-fs-'));
  logger = createLogger();
  store = new ContentStore({ dataDir: tempDir, logger });
  locks = createPathLockManager({
    dataDir: tempDir,
    logger,
    pollIntervalMs: 5,
    defaultTimeoutMs: 2000,
  });
  service = createService();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('write / read', () => {
  it('写新文件返回 created: true，读回正文', async () => {
    const target = uri('profile.md');

    const result = await service.write(target, '# Profile\n', AUTH_PRINCIPALS);

    expect(result.created).toBe(true);
    expect(result.uri.toString()).toBe(target.toString());
    expect(result.stat.kind).toBe('file');
    expect(result.stat.size).toBe('# Profile\n'.length);
    expect(await service.read(target, AUTH_PRINCIPALS)).toMatchObject({ text: '# Profile\n', frontmatter: null });
    expect(locks.activeCount()).toBe(0);
  });

  it('覆盖已存在的文件返回 created: false', async () => {
    const target = uri('profile.md');
    await service.write(target, '一', AUTH_PRINCIPALS);

    const result = await service.write(target, '二', AUTH_PRINCIPALS);

    expect(result.created).toBe(false);
    expect((await service.read(target, AUTH_PRINCIPALS)).text).toBe('二');
  });

  it('不传 frontmatter 时保留磁盘上现有的 frontmatter（§10.6）', async () => {
    const target = uri('profile.md');
    await service.write(target, '第一版', AUTH_PRINCIPALS, {
      frontmatter: { summary: '摘要', summaryDigest: 'abc', summaryState: 'fresh' },
    });

    await service.write(target, '第二版', AUTH_PRINCIPALS);

    const document = await service.read(target, AUTH_PRINCIPALS);
    expect(document.text).toBe('第二版');
    expect(document.frontmatter).toEqual({
      summary: '摘要',
      summaryDigest: 'abc',
      summaryState: 'fresh',
    });
  });

  it('读不存在的文件抛 NOT_FOUND', async () => {
    await expect(service.read(uri('missing.md'), AUTH_PRINCIPALS)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('readBytes 返回原始字节', async () => {
    const target = uri('raw.bin');
    await service.write(target, '字节', AUTH_PRINCIPALS);

    const bytes = await service.readBytes(target, AUTH_PRINCIPALS);

    expect(Buffer.from(bytes).toString('utf8')).toBe('字节');
  });
});

describe('stat', () => {
  it('文件返回 size 与 updatedAt，不存在返回 null', async () => {
    const target = uri('profile.md');
    await service.write(target, 'abc', AUTH_PRINCIPALS);

    const stat = await service.stat(target, AUTH_PRINCIPALS);
    expect(stat).toMatchObject({ kind: 'file', size: 3 });
    expect(Number.isNaN(Date.parse(stat?.updatedAt ?? ''))).toBe(false);

    expect(await service.stat(uri('missing.md'), AUTH_PRINCIPALS)).toBeNull();
  });

  it('目录的 size 是直接子项数', async () => {
    await service.write(uri('a.md'), 'a', AUTH_PRINCIPALS);
    await service.write(uri('b.md'), 'b', AUTH_PRINCIPALS);

    expect(await service.stat(Uri.parse(BASE), AUTH_PRINCIPALS)).toMatchObject({ kind: 'directory', size: 2 });
  });
});

describe('list', () => {
  it('按 name 升序返回直接子项，abstract 为 null', async () => {
    await service.write(uri('b.md'), 'b', AUTH_PRINCIPALS);
    await service.write(uri('a.md'), 'a', AUTH_PRINCIPALS);
    await service.mkdir(uri('sub'), AUTH_PRINCIPALS);

    const entries = await service.list(Uri.parse(BASE), AUTH_PRINCIPALS);

    expect(entries.map((entry) => entry.uri.name)).toEqual(['a.md', 'b.md', 'sub']);
    expect(entries.every((entry) => entry.abstract === null)).toBe(true);
    expect(entries.at(-1)).toMatchObject({ kind: 'directory' });
  });

  it('锁文件不是目录内容，不出现在列表与 size 里', async () => {
    await service.write(uri('b.md'), 'b', AUTH_PRINCIPALS);
    const release = await locks.acquire(uri('a.md'), 'exact');

    try {
      const entries = await service.list(Uri.parse(BASE), AUTH_PRINCIPALS);
      expect(entries.map((entry) => entry.uri.name)).toEqual(['b.md']);
      expect(await service.stat(Uri.parse(BASE), AUTH_PRINCIPALS)).toMatchObject({ size: 1 });
    } finally {
      release();
    }
  });

  it('无权限的节点完全不出现（§12.4）', async () => {
    await service.write(uri('a.md'), 'a', AUTH_PRINCIPALS);
    await service.write(uri('b.md'), 'b', AUTH_PRINCIPALS);

    const entries = await createService(new DenyAuthorizer([uri('b.md')])).list(
      Uri.parse(BASE),
      AUTH_PRINCIPALS,
    );

    expect(entries.map((entry) => entry.uri.toString())).toEqual([uri('a.md').toString()]);
  });
});

describe('tree', () => {
  beforeEach(async () => {
    await service.write(uri('a.md'), 'a', AUTH_PRINCIPALS);
    await service.write(uri('sub/b.md'), 'b', AUTH_PRINCIPALS);
    await service.write(uri('sub/deep/c.md'), 'c', AUTH_PRINCIPALS);
  });

  it('默认 depth 为 3，深度优先、同层按 name 升序', async () => {
    const result = await service.tree(Uri.parse(BASE), AUTH_PRINCIPALS);

    expect(result.root.toString()).toBe(BASE);
    expect(result.entries.map((entry) => entry.uri.toString())).toEqual([
      uri('a.md').toString(),
      uri('sub').toString(),
      uri('sub/b.md').toString(),
      uri('sub/deep').toString(),
      uri('sub/deep/c.md').toString(),
    ]);
    expect(result.truncated).toBe(false);
  });

  it('depth 触顶时置 truncated', async () => {
    const result = await service.tree(Uri.parse(BASE), AUTH_PRINCIPALS, { depth: 1 });

    expect(result.entries.map((entry) => entry.uri.name)).toEqual(['a.md', 'sub']);
    expect(result.truncated).toBe(true);
  });

  it('depth 0 只做截断判断，不返回条目', async () => {
    const result = await service.tree(Uri.parse(BASE), AUTH_PRINCIPALS, { depth: 0 });

    expect(result.entries).toEqual([]);
    expect(result.truncated).toBe(true);
  });

  it('limit 触顶时置 truncated 并停止', async () => {
    const result = await service.tree(Uri.parse(BASE), AUTH_PRINCIPALS, { depth: 3, limit: 2 });

    expect(result.entries).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('无权限的子树不出现', async () => {
    const result = await createService(new DenyAuthorizer([uri('sub')])).tree(
      Uri.parse(BASE),
      AUTH_PRINCIPALS,
    );

    expect(result.entries.map((entry) => entry.uri.name)).toEqual(['a.md']);
    expect(result.truncated).toBe(false);
  });
});

describe('只读操作不拿路径锁（缺陷 4）', () => {
  beforeEach(async () => {
    await service.write(uri('a.md'), 'a', AUTH_PRINCIPALS);
    await service.write(uri('sub/b.md'), 'b', AUTH_PRINCIPALS);
  });

  it('后台摘要持有根目录锁时 tree / list / stat 仍然立刻返回', async () => {
    // 缺陷现场：摘要重建在持有根目录锁的那 9.4 秒里调了一次模型，这段时间内
    // `GET /fs/tree` 会排队到 `acquire` 超时然后 409。这里用一把长租约的 TREE
    // 锁等价复现「写者长期持有」，只读操作必须直接读快照。
    const release = await locks.acquire(Uri.parse(BASE), 'tree', { timeoutMs: 50 });
    try {
      const startedAt = Date.now();
      const tree = await service.tree(Uri.parse(BASE), AUTH_PRINCIPALS);
      const listed = await service.list(Uri.parse(BASE), AUTH_PRINCIPALS);
      const stat = await service.stat(Uri.parse(BASE), AUTH_PRINCIPALS);
      const document = await service.read(uri('a.md'), AUTH_PRINCIPALS);

      expect(tree.entries.map((entry) => entry.uri.name)).toEqual(['a.md', 'sub', 'b.md']);
      expect(listed.map((entry) => entry.uri.name)).toEqual(['a.md', 'sub']);
      expect(stat?.kind).toBe('directory');
      expect(document.text).toBe('a');
      // 锁还在持有者手里，读没有排队（旧实现会等满超时再抛 CONFLICT）。
      expect(Date.now() - startedAt).toBeLessThan(1000);
    } finally {
      release();
    }
  });

  it('写操作仍然排队：读不拿锁不改变写者之间的互斥', async () => {
    const release = await locks.acquire(uri('a.md'), 'exact', { timeoutMs: 200 });
    let settled = false;
    const pending = service.write(uri('a.md'), 'blocked', AUTH_PRINCIPALS).finally(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);

    release();
    await pending;
    expect((await service.read(uri('a.md'), AUTH_PRINCIPALS)).text).toBe('blocked');
  });
});

describe('edit', () => {
  it('唯一命中时应用补丁并写回', async () => {
    const target = uri('a.md');
    await service.write(target, 'hello world', AUTH_PRINCIPALS);

    const result = await service.edit(target, [{ search: 'world', replace: 'comem' }], AUTH_PRINCIPALS);

    expect(result.applied).toBe(1);
    expect((await service.read(target, AUTH_PRINCIPALS)).text).toBe('hello comem');
  });

  it('not_found 时抛 INVALID_ARGUMENT，且不写文件', async () => {
    const target = uri('a.md');
    await service.write(target, 'hello', AUTH_PRINCIPALS);

    await expect(
      service.edit(target, [{ search: '不存在', replace: 'x' }], AUTH_PRINCIPALS),
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringContaining('not_found'),
    });

    expect((await service.read(target, AUTH_PRINCIPALS)).text).toBe('hello');
  });

  it('ambiguous 时抛 INVALID_ARGUMENT，且不写文件', async () => {
    const target = uri('a.md');
    await service.write(target, 'aaa', AUTH_PRINCIPALS);

    await expect(service.edit(target, [{ search: 'a', replace: 'b' }], AUTH_PRINCIPALS)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringContaining('ambiguous'),
    });

    expect((await service.read(target, AUTH_PRINCIPALS)).text).toBe('aaa');
  });
});

describe('mkdir / remove', () => {
  it('mkdir 建目录，重复调用不报错', async () => {
    const directory = uri('newdir');

    await service.mkdir(directory, AUTH_PRINCIPALS);
    await service.mkdir(directory, AUTH_PRINCIPALS);

    expect(await service.stat(directory, AUTH_PRINCIPALS)).toMatchObject({ kind: 'directory', size: 0 });
  });

  it('remove 删除文件并返回文件数', async () => {
    const target = uri('a.md');
    await service.write(target, 'a', AUTH_PRINCIPALS);

    expect(await service.remove(target, AUTH_PRINCIPALS)).toEqual({ removedFiles: 1 });
    expect(await service.stat(target, AUTH_PRINCIPALS)).toBeNull();
  });

  it('remove 不存在的路径返回 0，不报错', async () => {
    expect(await service.remove(uri('missing.md'), AUTH_PRINCIPALS)).toEqual({ removedFiles: 0 });
  });

  it('remove 目录递归删除，返回删除的文件数', async () => {
    await service.write(uri('dir/a.md'), 'a', AUTH_PRINCIPALS);
    await service.write(uri('dir/b.md'), 'b', AUTH_PRINCIPALS);

    expect(await service.remove(uri('dir'), AUTH_PRINCIPALS)).toEqual({ removedFiles: 2 });
    expect(await service.stat(uri('dir'), AUTH_PRINCIPALS)).toBeNull();
  });
});

describe('move', () => {
  it('移动文件后源不存在、目标可读', async () => {
    const from = uri('a.md');
    const to = uri('sub/a.md');
    await service.write(from, '内容', AUTH_PRINCIPALS);

    await service.move(from, to, AUTH_PRINCIPALS);

    expect((await service.read(to, AUTH_PRINCIPALS)).text).toBe('内容');
    await expect(service.read(from, AUTH_PRINCIPALS)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('目标已存在抛 ALREADY_EXISTS', async () => {
    await service.write(uri('from.md'), 'from', AUTH_PRINCIPALS);
    await service.write(uri('to.md'), 'to', AUTH_PRINCIPALS);

    await expect(service.move(uri('from.md'), uri('to.md'), AUTH_PRINCIPALS)).rejects.toMatchObject({
      code: 'ALREADY_EXISTS',
    });
  });

  it('移动到自己的子树里抛 INVALID_ARGUMENT', async () => {
    await service.mkdir(uri('dir'), AUTH_PRINCIPALS);

    await expect(service.move(uri('dir'), uri('dir/child'), AUTH_PRINCIPALS)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});

describe('授权', () => {
  it('写请求在无权限时抛 PERMISSION_DENIED，且不产生文件', async () => {
    const target = uri('a.md');
    const denied = createService(new DenyAuthorizer([target]));

    await expect(denied.write(target, 'x', AUTH_PRINCIPALS)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(await service.stat(target, AUTH_PRINCIPALS)).toBeNull();
  });

  it('删除需要 manage，读权限不够', async () => {
    const target = uri('a.md');
    await service.write(target, 'a', AUTH_PRINCIPALS);
    const denied = createService(new DenyAuthorizer([target]));

    await expect(denied.remove(target, AUTH_PRINCIPALS)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect((await service.read(target, AUTH_PRINCIPALS)).text).toBe('a');
  });
});

describe('观察者', () => {
  it('write 后通知 onNodeWritten(file)', async () => {
    const observer = new RecordingObserver();
    const service = createService(new AllowAllAuthorizer(), [observer]);
    const target = uri('a.md');

    await service.write(target, 'a', AUTH_PRINCIPALS);

    expect(observer.written).toEqual([{ uri: target.toString(), kind: 'file' }]);
    expect(observer.removed).toEqual([]);
  });

  it('mkdir 后通知 onNodeWritten(directory)', async () => {
    const observer = new RecordingObserver();
    const service = createService(new AllowAllAuthorizer(), [observer]);
    const target = uri('dir');

    await service.mkdir(target, AUTH_PRINCIPALS);

    expect(observer.written).toEqual([{ uri: target.toString(), kind: 'directory' }]);
  });

  it('目录 move 只通知一次 onNodeMoved，整棵子树由观察者重建', async () => {
    const observer = new RecordingObserver();
    const service = createService(new AllowAllAuthorizer(), [observer]);
    const from = uri('dir');
    const to = uri('moved');
    await service.mkdir(from, AUTH_PRINCIPALS);
    await service.write(from.child('one.md'), 'one', AUTH_PRINCIPALS);
    observer.written.length = 0;

    await service.move(from, to, AUTH_PRINCIPALS);

    // 一次通知，而不是「源删除 + 目标写入」两次：拆成两次时子项一条都不会重建。
    expect(observer.moved).toEqual([{ from: from.toString(), to: to.toString() }]);
    expect(observer.removed).toEqual([]);
    expect(observer.written).toEqual([]);
    expect((await service.list(to, AUTH_PRINCIPALS)).map((entry) => entry.uri.name)).toEqual(['one.md']);
  });

  it('remove 后通知 onNodeRemoved', async () => {
    const observer = new RecordingObserver();
    const service = createService(new AllowAllAuthorizer(), [observer]);
    const target = uri('a.md');
    await service.write(target, 'a', AUTH_PRINCIPALS);
    observer.written.length = 0;

    expect(await service.remove(target, AUTH_PRINCIPALS)).toEqual({ removedFiles: 1 });

    expect(observer.removed).toEqual([target.toString()]);
  });

  it('observer 抛错不阻断写操作，错误进日志', async () => {
    const unreliable: NodeWriteObserver = {
      async onNodeWritten() {
        throw new Error('索引挂了');
      },
      async onNodeRemoved() {
        throw new Error('索引挂了');
      },
      async onNodeMoved() {
        throw new Error('索引挂了');
      },
    };
    const service = createService(new AllowAllAuthorizer(), [unreliable]);
    const target = uri('a.md');

    const result = await service.write(target, 'a', AUTH_PRINCIPALS);

    expect(result.created).toBe(true);
    expect((await service.read(target, AUTH_PRINCIPALS)).text).toBe('a');
    expect(logger.errors).toContain('节点写入观察者失败，已忽略。');

    expect(await service.remove(target, AUTH_PRINCIPALS)).toEqual({ removedFiles: 1 });
    expect(logger.errors).toContain('节点删除观察者失败，已忽略。');
  });

  it('一个 observer 抛错不影响其它 observer', async () => {
    const failing: NodeWriteObserver = {
      async onNodeWritten() {
        throw new Error('索引挂了');
      },
      async onNodeRemoved() {
        throw new Error('索引挂了');
      },
      async onNodeMoved() {
        throw new Error('索引挂了');
      },
    };
    const observer = new RecordingObserver();
    const service = createService(new AllowAllAuthorizer(), [failing, observer]);
    const target = uri('a.md');

    await service.write(target, 'a', AUTH_PRINCIPALS);

    expect(observer.written).toEqual([{ uri: target.toString(), kind: 'file' }]);
  });
});
