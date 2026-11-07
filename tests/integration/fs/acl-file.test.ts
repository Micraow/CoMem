import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACL_FILE_NAME, AclFileStore } from '../../../src/adapters/fs/acl-file.js';
import type { AclFile, AclFileEntry } from '../../../src/adapters/fs/acl-file.js';
import { TEMP_FILE_PREFIX, toDiskPath } from '../../../src/adapters/fs/path.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { Logger } from '../../../src/domain/log.js';
import { Uri } from '../../../src/domain/uri.js';

const DIRECTORY = Uri.parse('comem://user/alice/memories');

// 按 principal 升序：写盘时固定排序，读回来就是这个顺序。
const SAMPLE: AclFile = {
  mode: 'inherit',
  entries: [
    { principal: 'group:eng', level: 'read', effect: 'allow' },
    { principal: 'user:alice', level: 'manage', effect: 'allow' },
  ],
};

let dataDir: string;
let store: AclFileStore;
let logger: Logger;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-acl-file-'));
  logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  store = new AclFileStore({ dataDir, logger });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function directoryPath(target: Uri = DIRECTORY): string {
  return toDiskPath(dataDir, target);
}

function aclPath(target: Uri = DIRECTORY): string {
  return join(directoryPath(target), ACL_FILE_NAME);
}

async function writeRaw(raw: string, target: Uri = DIRECTORY): Promise<void> {
  await mkdir(directoryPath(target), { recursive: true });
  await writeFile(aclPath(target), raw, 'utf8');
}

async function readRaw(target: Uri = DIRECTORY): Promise<string> {
  return readFile(aclPath(target), 'utf8');
}

async function expectComemError(
  run: () => Promise<unknown>,
  code: ComemError['code'],
): Promise<ComemError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ComemError);
    const comem = error as ComemError;
    expect(comem.code).toBe(code);
    return comem;
  }
  throw new Error(`期望抛出 ComemError(${code})，但没有抛错`);
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function entry(principal: string, level: AclFileEntry['level'], effect: AclFileEntry['effect']) {
  return { principal, level, effect };
}

describe('read', () => {
  it('文件不存在返回 null（「没有 ACL」不是「空 ACL」）', async () => {
    await expect(store.read(DIRECTORY)).resolves.toBeNull();
  });

  it('目录不存在也返回 null，不抛错', async () => {
    await expect(store.read(Uri.parse('comem://user/alice/never-created'))).resolves.toBeNull();
  });

  it('往返：写进去的方案能原样读出来', async () => {
    await store.write(DIRECTORY, SAMPLE);
    await expect(store.read(DIRECTORY)).resolves.toEqual(SAMPLE);
  });

  it('entries 为空是合法的（restricted 切断继承后的空授权）', async () => {
    const empty: AclFile = { mode: 'restricted', entries: [] };
    await store.write(DIRECTORY, empty);
    await expect(store.read(DIRECTORY)).resolves.toEqual(empty);
  });

  it('.acl.json 是目录时抛 INVALID_ARGUMENT', async () => {
    await mkdir(aclPath(), { recursive: true });

    const error = await expectComemError(() => store.read(DIRECTORY), 'INVALID_ARGUMENT');
    expect(error.message).toContain(DIRECTORY.toString());
  });
});

describe('严格解析', () => {
  it('不是合法 JSON', async () => {
    await writeRaw('{');
    const error = await expectComemError(() => store.read(DIRECTORY), 'INVALID_ARGUMENT');
    expect(error.message).toContain(aclPath());
    expect(error.message).toContain('（顶层）');
  });

  it('顶层不是对象', async () => {
    await writeRaw(json([SAMPLE.entries[0]]));
    const error = await expectComemError(() => store.read(DIRECTORY), 'INVALID_ARGUMENT');
    expect(error.message).toContain('（顶层）');
  });

  it('mode 缺失或不在枚举内', async () => {
    await writeRaw(json({ entries: [] }));
    const missing = await expectComemError(() => store.read(DIRECTORY), 'INVALID_ARGUMENT');
    expect(missing.message).toContain('mode');

    await writeRaw(json({ mode: 'open', entries: [] }));
    const invalid = await expectComemError(() => store.read(DIRECTORY), 'INVALID_ARGUMENT');
    expect(invalid.message).toContain('mode');
  });

  it('entries 缺失或不是数组', async () => {
    await writeRaw(json({ mode: 'inherit' }));
    const missing = await expectComemError(() => store.read(DIRECTORY), 'INVALID_ARGUMENT');
    expect(missing.message).toContain('entries');

    await writeRaw(json({ mode: 'inherit', entries: {} }));
    const invalid = await expectComemError(() => store.read(DIRECTORY), 'INVALID_ARGUMENT');
    expect(invalid.message).toContain('entries');
  });

  it('level 必须是 read / write / manage 字符串', async () => {
    await writeRaw(
      json({ mode: 'inherit', entries: [{ ...entry('user:alice', 'read', 'allow'), level: 7 }] }),
    );

    const error = await expectComemError(() => store.read(DIRECTORY), 'INVALID_ARGUMENT');
    expect(error.message).toContain('entries[0].level');
    expect(error.message).toContain(aclPath());
  });

  it('effect 必须是 allow / deny', async () => {
    await writeRaw(
      json({ mode: 'inherit', entries: [{ ...entry('user:alice', 'read', 'allow'), effect: 'grant' }] }),
    );

    const error = await expectComemError(() => store.read(DIRECTORY), 'INVALID_ARGUMENT');
    expect(error.message).toContain('entries[0].effect');
  });

  it('principal 必须以 user: 或 group: 开头', async () => {
    for (const principal of ['alice', ':alice', 'user:', 'admin:alice', 'group:*']) {
      await writeRaw(json({ mode: 'inherit', entries: [entry(principal, 'read', 'allow')] }));

      const error = await expectComemError(() => store.read(DIRECTORY), 'INVALID_ARGUMENT');
      expect(error.message).toContain('entries[0].principal');
      expect(error.message).toContain(aclPath());
    }
  });

  it('条目不是对象', async () => {
    await writeRaw(json({ mode: 'inherit', entries: ['user:alice'] }));
    const error = await expectComemError(() => store.read(DIRECTORY), 'INVALID_ARGUMENT');
    expect(error.message).toContain('entries[0]');
  });
});

describe('未知字段', () => {
  it('顶层与条目级的未知字段在重写后保留', async () => {
    await writeRaw(
      JSON.stringify(
        {
          mode: 'inherit',
          comment: '手工加的注释',
          entries: [
            { principal: 'user:alice', level: 'manage', effect: 'allow', note: '拥有者' },
          ],
        },
        null,
        2,
      ),
    );

    await store.write(DIRECTORY, {
      mode: 'inherit',
      entries: [entry('user:alice', 'manage', 'allow')],
    });

    const parsed = JSON.parse(await readRaw()) as Record<string, unknown>;
    expect(parsed['comment']).toBe('手工加的注释');
    const entries = parsed['entries'] as Record<string, unknown>[];
    expect(entries[0]?.['note']).toBe('拥有者');
  });

  it('已有文件写坏了也能覆盖（未知字段保留不了，但不能卡住写入）', async () => {
    await writeRaw('{ 半截');

    await expect(
      store.write(DIRECTORY, { mode: 'restricted', entries: [] }),
    ).resolves.toBeUndefined();

    await expect(store.read(DIRECTORY)).resolves.toEqual({ mode: 'restricted', entries: [] });
  });
});

describe('序列化', () => {
  it('键顺序固定：mode 在前、entries 次之、未知键升序', async () => {
    await writeRaw(
      JSON.stringify({
        zeta: 1,
        entries: [],
        mode: 'inherit',
        alpha: 2,
      }),
    );

    await store.write(DIRECTORY, { mode: 'inherit', entries: [] });

    const parsed = JSON.parse(await readRaw()) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['mode', 'entries', 'alpha', 'zeta']);
  });

  it('entries 按 principal 升序', async () => {
    await store.write(DIRECTORY, {
      mode: 'inherit',
      entries: [
        entry('user:bob', 'read', 'allow'),
        entry('group:eng', 'write', 'allow'),
        entry('user:alice', 'manage', 'allow'),
      ],
    });

    const parsed = JSON.parse(await readRaw()) as { entries: AclFileEntry[] };
    expect(parsed.entries.map((item) => item.principal)).toEqual([
      'group:eng',
      'user:alice',
      'user:bob',
    ]);
  });

  it('同样的 ACL 写两次产生同样的字节', async () => {
    await store.write(DIRECTORY, SAMPLE);
    const first = await readRaw();

    const readBack = await store.read(DIRECTORY);
    expect(readBack).not.toBeNull();
    if (readBack !== null) {
      await store.write(DIRECTORY, readBack);
    }

    expect(await readRaw()).toBe(first);
  });

  it('以换行结尾，方便 git 与编辑器', async () => {
    await store.write(DIRECTORY, SAMPLE);
    expect((await readRaw()).endsWith('\n')).toBe(true);
  });
});

describe('原子写', () => {
  it('写完之后没有临时文件残留', async () => {
    await store.write(DIRECTORY, SAMPLE);

    const names = await readdir(directoryPath());
    expect(names.filter((name) => name.startsWith(TEMP_FILE_PREFIX))).toEqual([]);
    expect(names).toEqual([ACL_FILE_NAME]);
  });

  it('父目录不存在时自动创建', async () => {
    const nested = Uri.parse('comem://user/alice/projects/comem/memories');
    await store.write(nested, SAMPLE);

    await expect(store.read(nested)).resolves.toEqual(SAMPLE);
  });
});

describe('remove / exists', () => {
  it('只删 ACL 文件，不动目录内容', async () => {
    await store.write(DIRECTORY, SAMPLE);
    await writeFile(join(directoryPath(), 'note.md'), '内容\n', 'utf8');

    await store.remove(DIRECTORY);

    await expect(readdir(directoryPath())).resolves.toEqual(['note.md']);
    await expect(store.read(DIRECTORY)).resolves.toBeNull();
  });

  it('不存在时是空操作，可以重复调用', async () => {
    await expect(store.remove(DIRECTORY)).resolves.toBeUndefined();
    await expect(store.remove(DIRECTORY)).resolves.toBeUndefined();
  });

  it('exists 判断文件是否存在', async () => {
    await expect(store.exists(DIRECTORY)).resolves.toBe(false);
    await store.write(DIRECTORY, SAMPLE);
    await expect(store.exists(DIRECTORY)).resolves.toBe(true);
    await store.remove(DIRECTORY);
    await expect(store.exists(DIRECTORY)).resolves.toBe(false);
  });

  it('名叫 .acl.json 的目录不算 ACL 文件', async () => {
    await mkdir(aclPath(), { recursive: true });
    await expect(store.exists(DIRECTORY)).resolves.toBe(false);
  });
});
