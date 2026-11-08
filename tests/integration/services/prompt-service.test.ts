/**
 * 提示词用例的验收（架构文档 §9.2、§11.3、§11.4、§18）。
 *
 * 用真实 SQLite（`:memory:`）与真实的 `PromptRepository`：这一层的价值全在
 * 「覆盖优先于默认」「删掉覆盖回到默认」「启动时校验已有覆盖」上，用替身测等于
 * 测替身。
 *
 * 三组断言：
 *
 * 1. **优先级**：默认 → 保存 → 默认 → 恢复默认。
 * 2. **校验**：保存前的语法与变量检查、渲染时的缺值检查。
 * 3. **版本漂移**：`base_digest` 对不上时 `stale` 为真。
 */

import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { PromptRepository } from '../../../src/adapters/sqlite/prompt-repository.js';
import { ComemError } from '../../../src/domain/errors.js';
import { stableDigest } from '../../../src/domain/node.js';
import { PROMPT_IDS } from '../../../src/domain/prompt.js';
import { PromptService } from '../../../src/services/prompt-service.js';
import {
  DEFAULT_PROMPT_RENDERER,
  bindPromptRenderer,
} from '../../../src/services/prompts/registry.js';
import { REWRITE_SYSTEM_PROMPT } from '../../../src/services/prompts/rewrite.js';

let db: DatabaseSync;
let repository: PromptRepository;
let service: PromptService;

function expectError(run: () => unknown): ComemError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ComemError);
    return error as ComemError;
  }
  throw new Error('期望抛出 ComemError，但它正常返回了');
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  repository = new PromptRepository({ db });
  service = new PromptService({ overrides: repository });
  bindPromptRenderer(service);
});

afterEach(() => {
  // 全局渲染器是进程级状态（`prompts/registry.ts` 的取舍）：不还原会让同文件里
  // 后面的用例看到上一个用例的覆盖。
  bindPromptRenderer(DEFAULT_PROMPT_RENDERER);
  db.close();
});

describe('默认值与覆盖', () => {
  it('初始状态：六条提示词都使用默认值', () => {
    const list = service.list();

    expect(list.map((summary) => summary.id)).toEqual([...PROMPT_IDS]);
    expect(list.every((summary) => !summary.overridden)).toBe(true);
    expect(list.every((summary) => !summary.stale)).toBe(true);
    expect(list.every((summary) => summary.updatedAt === null)).toBe(true);
  });

  it('没有覆盖时生效正文就是仓库默认正文', () => {
    const detail = service.get('extract-user');

    expect(detail.body).toBe(detail.defaultBody);
    expect(detail.overridden).toBe(false);
  });

  it('保存之后覆盖优先', () => {
    const saved = service.save('extract-user', '## 已读记忆\n\n{{pages}}\n\n自定义结尾。');

    expect(saved.overridden).toBe(true);
    expect(saved.body).toBe('## 已读记忆\n\n{{pages}}\n\n自定义结尾。');
    expect(saved.body).not.toBe(saved.defaultBody);
    expect(service.get('extract-user').body).toBe('## 已读记忆\n\n{{pages}}\n\n自定义结尾。');
    expect(service.render('extract-user', { pages: 'P', messages: '', previousOverviewSection: '' })).toBe(
      '## 已读记忆\n\nP\n\n自定义结尾。',
    );
  });

  it('保存去掉结尾换行（文件与编辑器都会补一个）', () => {
    const saved = service.save('extract-user', '第一行\n\n');
    expect(saved.body).toBe('第一行');
  });

  it('恢复默认之后回到仓库正文', () => {
    const original = service.get('extract-user').defaultBody;
    service.save('extract-user', '改过的正文');

    const reset = service.reset('extract-user');

    expect(reset.overridden).toBe(false);
    expect(reset.body).toBe(original);
    expect(reset.updatedAt).toBeNull();
  });

  it('删掉不存在的覆盖不是错误', () => {
    expect(service.reset('rewrite-user').overridden).toBe(false);
  });

  it('覆盖跨实例保留（重新构造服务仍读得到）', () => {
    service.save('summarize-user', '## 目录\n\nuri: {{uri}}\n\n## 直接子节点\n\n{{children}}');

    const reopened = new PromptService({ overrides: repository });

    expect(reopened.get('summarize-user').overridden).toBe(true);
    expect(reopened.get('summarize-user').body).toContain('## 直接子节点');
  });

  it('覆盖只影响自己那一条', () => {
    service.save('rewrite-user', '{{query}}');

    expect(service.get('rewrite-user').overridden).toBe(true);
    expect(service.get('rewrite-system').overridden).toBe(false);
  });
});

describe('版本漂移', () => {
  it('覆盖基于旧默认值时 stale 为真', () => {
    // 直接写一行「基于旧默认值」的覆盖：模拟仓库里的默认模板在保存之后被改过。
    repository.upsert({
      promptId: 'extract-user',
      body: '旧版本的覆盖',
      baseDigest: stableDigest('旧版本的默认值'),
      updatedAt: '2026-11-01T00:00:00.000Z',
    });
    const drifted = new PromptService({ overrides: repository });

    expect(drifted.get('extract-user').stale).toBe(true);
    // 覆盖仍然生效——漂移是提示，不是拒绝。
    expect(drifted.get('extract-user').body).toBe('旧版本的覆盖');
  });

  it('重新保存一次之后不再漂移', () => {
    repository.upsert({
      promptId: 'extract-user',
      body: '旧版本的覆盖',
      baseDigest: stableDigest('旧版本的默认值'),
      updatedAt: '2026-11-01T00:00:00.000Z',
    });
    const drifted = new PromptService({ overrides: repository });

    expect(drifted.save('extract-user', '旧版本的覆盖').stale).toBe(false);
  });
});

describe('校验', () => {
  it('保存时拒绝未知变量，并带行号', () => {
    const error = expectError(() => service.save('extract-user', '## 已读记忆\n\n{{pagess}}'));

    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.message).toContain('第 3 行');
    expect(error.details?.['variable']).toBe('pagess');
  });

  it('保存时拒绝未闭合的占位符', () => {
    expectError(() => service.save('extract-user', '{{ pages'));
  });

  it('启动时拒绝数据库里已有的非法覆盖', () => {
    repository.upsert({
      promptId: 'rewrite-system',
      body: '{{不存在的变量}}',
      baseDigest: stableDigest('x'),
      updatedAt: '2026-11-01T00:00:00.000Z',
    });

    const error = expectError(() => new PromptService({ overrides: repository }));
    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.details?.['promptId']).toBe('rewrite-system');
  });

  it('渲染时缺变量抛错，不把占位符发给模型', () => {
    const error = expectError(() => service.render('extract-user', { pages: 'P' }));

    expect(error.code).toBe('INVALID_ARGUMENT');
    // 报的是模板里第一个缺的变量（`previousOverviewSection` 在 `messages` 之前）。
    expect(error.message).toContain('previousOverviewSection');
  });
});

describe('预览', () => {
  it('没传的变量填中文说明，不露出变量名以外的术语', () => {
    const text = service.preview('extract-user', { pages: '## 已读记忆正文' });

    expect(text).toContain('## 已读记忆正文');
    expect(text).toContain('〔这次要抽取的会话消息〕');
    expect(text).not.toContain('{{');
  });

  it('预览用当前生效的覆盖', () => {
    service.save('extract-user', '只有 {{pages}}');
    expect(service.preview('extract-user', { pages: 'P' })).toBe('只有 P');
  });
});

describe('进程级渲染器', () => {
  it('保存 rewrite-system 之后 REWRITE_SYSTEM_PROMPT 立刻变化', () => {
    const before = REWRITE_SYSTEM_PROMPT;
    expect(before).toContain('查询重写器');

    service.save('rewrite-system', '新的系统提示词：最多 {{maxTypedQueries}} 条。');

    expect(REWRITE_SYSTEM_PROMPT).toBe('新的系统提示词：最多 5 条。');
  });

  it('恢复默认之后 REWRITE_SYSTEM_PROMPT 回到仓库正文', () => {
    // 默认正文里还有 `{{maxTypedQueries}}`，渲染后才是 `5`——所以比的是渲染结果。
    const original = REWRITE_SYSTEM_PROMPT;
    service.save('rewrite-system', '临时正文');
    expect(REWRITE_SYSTEM_PROMPT).toBe('临时正文');

    service.reset('rewrite-system');

    expect(REWRITE_SYSTEM_PROMPT).toBe(original);
  });
});
