import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LOCK_FILE_SUFFIX,
  RESERVED_NAMES,
  TEMP_FILE_PREFIX,
  fromDiskPath,
  isArtifactName,
  isReservedName,
  isWindowsReservedName,
  scopeRootOf,
  toDiskLocation,
  toDiskPath,
} from '../../../src/adapters/fs/path.js';
import { ComemError } from '../../../src/domain/errors.js';
import { Uri } from '../../../src/domain/uri.js';

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-path-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function expectInvalidUri(run: () => unknown): ComemError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ComemError);
  const error = caught as ComemError;
  expect(error.code).toBe('INVALID_URI');
  return error;
}

/**
 * 架构文档 §6.2 规则 6 的六个保留名，硬编码一份：`uri.ts` 没有导出它的集合，
 * 只能靠行为断言两边一致，写死才能发现「一边改了另一边没改」。
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

describe('isWindowsReservedName', () => {
  it('识别设备名，大小写不敏感', () => {
    for (const name of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'com9', 'LPT1', 'lpt9']) {
      expect(isWindowsReservedName(name), name).toBe(true);
    }
  });

  it('按第一个点之前的部分判定，CON.md 同样不可创建', () => {
    expect(isWindowsReservedName('CON.md')).toBe(true);
    expect(isWindowsReservedName('con.tar.gz')).toBe(true);
    // Windows 会吞掉名字末尾的空格。
    expect(isWindowsReservedName('CON ')).toBe(true);
  });

  it('普通名字与相似前缀不误判', () => {
    for (const name of ['console.md', 'com10', 'lpt0', 'null.md', 'auxiliary', 'a.md']) {
      expect(isWindowsReservedName(name), name).toBe(false);
    }
  });
});

describe('scopeRootOf', () => {
  it('user 作用域', () => {
    expect(scopeRootOf(dataDir, 'user', 'alice')).toBe(join(dataDir, 'user', 'alice'));
  });

  it('group 作用域', () => {
    expect(scopeRootOf(dataDir, 'group', 'eng')).toBe(join(dataDir, 'group', 'eng'));
  });

  it('根标识可以是邮箱', () => {
    expect(scopeRootOf(dataDir, 'user', 'alice@example.com')).toBe(
      join(dataDir, 'user', 'alice@example.com'),
    );
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
    expect(toDiskPath(dataDir, uri)).toBe(scopeRootOf(dataDir, 'group', 'eng'));
  });

  it('段里的空格、井号、问号、百分号原样保留', () => {
    const uri = Uri.parse('comem://user/alice/资源/a b#c?d%e.md');

    expect(toDiskPath(dataDir, uri)).toBe(join(dataDir, 'user', 'alice', '资源', 'a b#c?d%e.md'));
  });
});

describe('toDiskLocation', () => {
  it('absolute 与 relative 同时给出，relative 固定用 /', () => {
    const uri = Uri.parse('comem://user/alice/memories/foo.md');
    const location = toDiskLocation(dataDir, uri);

    expect(location.uri).toBe(uri);
    expect(location.absolute).toBe(join(dataDir, 'user', 'alice', 'memories', 'foo.md'));
    expect(location.relative).toBe('user/alice/memories/foo.md');
  });

  it('relative 不含平台分隔符', () => {
    const location = toDiskLocation(dataDir, Uri.parse('comem://group/eng/resources/docs/spec.pdf'));

    expect(location.relative).toBe('group/eng/resources/docs/spec.pdf');
    expect(location.relative.split('/')).toHaveLength(5);
  });
});

describe('fromDiskPath', () => {
  const URIS = [
    'comem://user/alice',
    'comem://group/eng',
    'comem://user/alice/memories/profile.md',
    'comem://user/alice/memories/preferences/code-style.md',
    'comem://user/alice/projects/comem/memories/entities/retrieval-pipeline.md',
    'comem://group/eng/resources/docs/architecture.md',
    'comem://user/alice@example.com/skills/code-review/SKILL.md',
    // 特殊字符：中文、空格、#、?、%、emoji、全角标点。
    'comem://user/alice/memories/中文 文件名.md',
    'comem://user/alice/memories/a#b?c%d.md',
    'comem://user/alice/memories/100% 完成.md',
    'comem://user/alice/memories/😀/🎉.md',
    'comem://user/alice/memories/．全角．点．.md',
    'comem://user/alice/memories/a..b.md',
    'comem://user/alice/memories/.隐藏文件.md',
    'comem://user/alice/memories/with  space/and#hash.md',
    'comem://user/alice/sessions/sess_7f3a91c2/history/archive_001/messages.jsonl',
  ];

  it('是 toDiskPath 的逆运算', () => {
    for (const input of URIS) {
      const uri = Uri.parse(input);
      const restored = fromDiskPath(dataDir, toDiskPath(dataDir, uri));

      expect(restored.toString(), input).toBe(uri.toString());
      expect(restored.equals(uri), input).toBe(true);
    }
  });

  it('接受带末尾斜杠的目录路径', () => {
    const restored = fromDiskPath(dataDir, `${join(dataDir, 'user', 'alice', 'memories')}${sep}`);

    expect(restored.toString()).toBe('comem://user/alice/memories');
  });

  it('规范化重复与尾部斜杠后再还原', () => {
    const restored = fromDiskPath(dataDir, `${dataDir}${sep}user${sep}alice${sep}memories${sep}`);

    expect(restored.toString()).toBe('comem://user/alice/memories');
  });

  it('数据根自身不是 URI', () => {
    expectInvalidUri(() => fromDiskPath(dataDir, dataDir));
  });

  it('缺少根标识', () => {
    expectInvalidUri(() => fromDiskPath(dataDir, join(dataDir, 'user')));
  });

  it('拒绝逃出数据根的 ..', () => {
    expectInvalidUri(() => fromDiskPath(dataDir, join(dataDir, '..', 'etc', 'passwd')));
    expectInvalidUri(() => fromDiskPath(dataDir, join(dataDir, 'user', '..', '..', 'etc')));
  });

  it('拒绝数据根之外的绝对路径', () => {
    expectInvalidUri(() => fromDiskPath(dataDir, join(tmpdir(), 'comem-outside', 'user', 'alice')));
  });

  it('拒绝保留名路径段', () => {
    for (const name of EXPECTED_RESERVED_NAMES) {
      expectInvalidUri(() => fromDiskPath(dataDir, join(dataDir, 'user', 'alice', 'memories', name)));
    }
  });

  it('拒绝反斜杠与控制字符（Uri 段规则）', () => {
    expectInvalidUri(() => fromDiskPath(dataDir, join(dataDir, 'user', 'alice', 'a\\b.md')));
    expectInvalidUri(() => fromDiskPath(dataDir, join(dataDir, 'user', 'alice', 'a\u0001b.md')));
  });
});
