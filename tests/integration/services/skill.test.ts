import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AclFileStore } from '../../../src/adapters/fs/acl-file.js';
import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import { createPathLockManager, type PathLockManager } from '../../../src/adapters/fs/lock.js';
import { MetadataFileStore } from '../../../src/adapters/fs/metadata-file.js';
import { ReconcileLog } from '../../../src/adapters/fs/reconcile-log.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { NodeRepository } from '../../../src/adapters/sqlite/node-repository.js';
import { PermissionRepository } from '../../../src/adapters/sqlite/permission-repository.js';
import { SqliteFtsIndex } from '../../../src/adapters/sqlite/retrieval-index.js';
import { InheritingAuthorizer } from '../../../src/bootstrap/container.js';
import type { Logger } from '../../../src/domain/log.js';
import { Uri } from '../../../src/domain/uri.js';
import { AclService } from '../../../src/services/acl.js';
import { FileSystemService } from '../../../src/services/filesystem.js';
import { SkillService } from '../../../src/services/skill.js';
import { RuleSummarizer, SummaryService } from '../../../src/services/summary.js';

const AUTH_PRINCIPALS: readonly string[] = ['user:alice', 'user:*'];

const SCOPE = 'comem://user/alice';
const SKILLS = `${SCOPE}/skills`;
const SKILL = `${SKILLS}/code-review`;

const SKILL_MD = `---
name: code-review
description: 代码审查清单
---

# Code Review
`;

let dataDir: string;
let db: DatabaseSync;
let store: ContentStore;
let locks: PathLockManager;
let index: SqliteFtsIndex;
let summary: SummaryService;
let permissions: PermissionRepository;
let logger: Logger;
let service: SkillService;
let filesystem: FileSystemService;

function createLogger(): Logger {
  const logger: Logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger;
}

function encode(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

function skillOptions(
  name: string,
  files: readonly { readonly path: string; readonly content: Uint8Array }[],
): Parameters<SkillService['addSkill']>[0] {
  return {
    parentUri: Uri.parse(SKILLS),
    name,
    files,
    subject: 'user:alice',
    principals: ['user:alice'],
  };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-skill-'));
  logger = createLogger();
  db = openDatabase(':memory:');
  runMigrations(db);
  store = new ContentStore({ dataDir, logger });
  locks = createPathLockManager({ dataDir, logger, pollIntervalMs: 5, defaultTimeoutMs: 2000 });
  index = new SqliteFtsIndex({ db, logger });
  permissions = new PermissionRepository({ db, logger });
  // 与生产装配同一份：写路径在物化表缺行时先物化再求权（`InheritingAuthorizer`）。
  const acl = new AclService({
    dataDir,
    db,
    aclFile: new AclFileStore({ dataDir, logger }),
    permissions,
    nodes: new NodeRepository({ db, logger }),
    logger,
    locks,
  });
  summary = new SummaryService({
    nodes: new NodeRepository({ db, logger }),
    index,
    metadata: new MetadataFileStore({ dataDir, logger }),
    store,
    db,
    acl,
    generator: new RuleSummarizer(),
    logger,
    locks,
    config: { abstractMaxChars: 256, overviewMaxChars: 4000 },
  });
  await acl.ensureRootPreset(Uri.parse(SCOPE));
  const authorizer = new InheritingAuthorizer(acl, store);
  filesystem = new FileSystemService({ store, locks, authorizer, logger });
  service = new SkillService({
    store,
    locks,
    index,
    summary,
    reconcile: new ReconcileLog({ dataDir, logger }),
    permissions,
    logger,
    authorizer,
  });
});

afterEach(async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('addSkill', () => {
  it('正常安装：入口与脚本落盘并进索引', async () => {
    const markStale = vi.spyOn(summary, 'markStale');

    const result = await service.addSkill(
      skillOptions('code-review', [
        { path: 'SKILL.md', content: encode(SKILL_MD) },
        { path: 'scripts/check.sh', content: encode('#!/bin/sh\nexit 0\n') },
      ]),
    );

    expect(result.skillUri.toString()).toBe(SKILL);
    expect(result.fileCount).toBe(2);

    expect(await readFile(join(dataDir, 'user/alice/skills/code-review/SKILL.md'), 'utf8')).toBe(
      SKILL_MD,
    );
    expect(
      await readFile(join(dataDir, 'user/alice/skills/code-review/scripts/check.sh'), 'utf8'),
    ).toContain('exit 0');

    const entry = await index.stat(`${SKILL}/SKILL.md`);
    expect(entry).not.toBeNull();
    expect(entry?.contextType).toBe('skill');
    expect(entry?.abstract).toBe('代码审查清单');

    // 两个文件分属两个目录（技能根与 scripts/），所以失效投递两次。
    expect(markStale).toHaveBeenCalledTimes(2);
    expect(locks.activeCount()).toBe(0);
  });

  it('安装后 list(parent) 能看到技能目录，技能根与文件都有物化权限行', async () => {
    await service.addSkill(
      skillOptions('code-review', [
        { path: 'SKILL.md', content: encode(SKILL_MD) },
        { path: 'scripts/check.sh', content: encode('#!/bin/sh\nexit 0\n') },
      ]),
    );

    // 技能服务直接写 `ContentStore`，观察者收不到通知。物化权限漏掉时 `list` 与
    // `listSkills` 都会把技能整个过滤掉——装成功了，列表里却没有。
    const listed = await filesystem.list(Uri.parse(SKILLS), AUTH_PRINCIPALS);
    expect(listed.map((entry) => entry.uri.toString())).toContain(SKILL);

    const visible = await service.listSkills(Uri.parse(SCOPE), {
      subject: 'user:alice',
      principals: ['user:alice'],
    });
    expect(visible.map((uri) => uri.toString())).toEqual([SKILL]);

    for (const uri of [SKILL, `${SKILL}/SKILL.md`, `${SKILL}/scripts`]) {
      const rows = db
        .prepare('SELECT principal, level, effect FROM node_permission WHERE node_uri = ?')
        .all(uri);
      expect(rows.length).toBeGreaterThan(0);
    }
  });

  it('缺少 SKILL.md 抛 INVALID_ARGUMENT', async () => {
    await expect(
      service.addSkill(skillOptions('code-review', [{ path: 'README.md', content: encode('x') }])),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('SKILL.md 的 frontmatter 缺 name 抛 INVALID_ARGUMENT', async () => {
    await expect(
      service.addSkill(
        skillOptions('code-review', [
          { path: 'SKILL.md', content: encode('---\ndescription: 只有描述\n---\n') },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('SKILL.md 的 frontmatter 缺 description 抛 INVALID_ARGUMENT', async () => {
    await expect(
      service.addSkill(
        skillOptions('code-review', [
          { path: 'SKILL.md', content: encode('---\nname: code-review\n---\n') },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('SKILL.md 没有 frontmatter 抛 INVALID_ARGUMENT', async () => {
    await expect(
      service.addSkill(
        skillOptions('code-review', [{ path: 'SKILL.md', content: encode('# 没有 frontmatter') }]),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it.each(['Code-Review', 'code_review', '..', '.abstract.md', 'code/review', '-leading'])(
    '非法技能名 %s 抛 INVALID_ARGUMENT',
    async (name) => {
      await expect(
        service.addSkill(skillOptions(name, [{ path: 'SKILL.md', content: encode(SKILL_MD) }])),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    },
  );
});

describe('listSkills', () => {
  async function install(name: string): Promise<Uri> {
    const result = await service.addSkill(
      skillOptions(name, [{ path: 'SKILL.md', content: encode(SKILL_MD) }]),
    );
    return result.skillUri;
  }

  it('只返回调用方有 read 权限的技能', async () => {
    const visible = await install('alpha');
    const hidden = await install('beta');

    // 安装会为技能目录物化权限（从根继承），所以要把 beta 换成「只授权给别人」的
    // 行——`readableUris` 是纯 SQL 过滤，不在调用方主体集合里的行等于看不见。
    permissions.replaceNode(hidden.toString(), [
      { nodeUri: hidden.toString(), principal: 'user:bob', level: 7, effect: 'allow' },
    ]);

    const listed = await service.listSkills(Uri.parse(SCOPE), {
      subject: 'user:alice',
      principals: ['user:alice'],
    });

    expect(listed.map((uri) => uri.toString())).toEqual([visible.toString()]);
  });

  it('没有技能目录时返回空列表', async () => {
    const listed = await service.listSkills(Uri.parse(SCOPE), {
      subject: 'user:alice',
      principals: ['user:alice'],
    });
    expect(listed).toEqual([]);
  });
});
