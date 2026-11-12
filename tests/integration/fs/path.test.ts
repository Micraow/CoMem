import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LOCK_FILE_SUFFIX,
  RESERVED_NAMES,
  TEMP_FILE_PREFIX,
  isArtifactName,
  isReservedName,
  toDiskPath,
} from '../../../src/adapters/fs/path.js';
import { Uri } from '../../../src/domain/uri.js';

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-path-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/**
 * 架构文档 §6.2 规则 6 的六个保留名，硬编码一份：`path.ts` 现在是 `domain/uri.ts`
 * 那份集合的引用（不再是副本），所以内容断言改成防「架构文档与唯一来源漂移」。
 * `.history` 不在其中，理由见 `path.ts` 的注释。
 */
const EXPECTED_RESERVED_NAMES = [
  '.abstract.md',
  '.overview.md',
  '.acl.json',
  '.meta.json',
  '.done',
  'memory_diff.json',
  'memory_operations.json',
];

describe('RESERVED_NAMES', () => {
  it('内容与架构文档 §6.2 规则 6 一致', () => {
    expect([...RESERVED_NAMES].sort()).toEqual([...EXPECTED_RESERVED_NAMES].sort());
  });

  it('与 Uri 的保留名判定逐个一致', () => {
    const candidates = [
      ...EXPECTED_RESERVED_NAMES,
      '.hidden.md',
      'abstract.md',
      'overview.md',
      'acl.json',
      'meta.json',
      'done',
      '.done.md',
      'memory_diff.md',
      '.ACL.json',
      'foo',
      'a.md',
    ];

    for (const name of candidates) {
      const rejectedByUri = Uri.tryParse(`comem://user/alice/memories/${name}`) === null;
      expect(isReservedName(name), name).toBe(rejectedByUri);
    }
  });
});

describe('isArtifactName', () => {
  it('三类正例：元数据文件、锁文件、临时文件', () => {
    for (const name of EXPECTED_RESERVED_NAMES) {
      expect(isArtifactName(name), name).toBe(true);
    }
    expect(isArtifactName('a.md.comem-lock')).toBe(true);
    expect(isArtifactName(LOCK_FILE_SUFFIX)).toBe(true);
    expect(isArtifactName(`${TEMP_FILE_PREFIX}abc123`)).toBe(true);
  });

  it('普通文件名不命中', () => {
    expect(isArtifactName('a.md')).toBe(false);
    expect(isArtifactName('.comem-lock.bak')).toBe(false);
    expect(isArtifactName('x.comem-lock.md')).toBe(false);
  });

  it('常量与架构文档 §10.6 一致', () => {
    expect(LOCK_FILE_SUFFIX).toBe('.comem-lock');
    expect(TEMP_FILE_PREFIX).toBe('.comem-tmp-');
    // 锁文件是「目标文件名 + 后缀」，不是恰好叫 .comem-lock。
    expect(`${'a.md'}${LOCK_FILE_SUFFIX}`).toBe('a.md.comem-lock');
  });
});

describe('toDiskPath', () => {
  it('镜像 URI 的层级', () => {
    const uri = Uri.parse('comem://user/alice/memories/preferences/code-style.md');

    expect(toDiskPath(dataDir, uri)).toBe(
      join(dataDir, 'user', 'alice', 'memories', 'preferences', 'code-style.md'),
    );
  });

  it('根节点落在作用域根目录', () => {
    const uri = Uri.parse('comem://group/eng');

    expect(toDiskPath(dataDir, uri)).toBe(join(dataDir, 'group', 'eng'));
  });

  it('段里的空格、井号、问号、百分号原样保留', () => {
    const uri = Uri.parse('comem://user/alice/资源/a b#c?d%e.md');

    expect(toDiskPath(dataDir, uri)).toBe(join(dataDir, 'user', 'alice', '资源', 'a b#c?d%e.md'));
  });
});

