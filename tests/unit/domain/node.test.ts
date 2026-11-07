import { describe, expect, it } from 'vitest';

import { ComemError } from '../../../src/domain/errors.js';
import {
  Directory,
  Document,
  stableDigest,
  type DirectoryInit,
  type DocumentInit,
} from '../../../src/domain/node.js';
import { Uri } from '../../../src/domain/uri.js';

const NOW = '2026-11-05T16:40:00.000Z';

function document(uri: string, content: string, init: Partial<DocumentInit> = {}): Document {
  return new Document({ uri: Uri.parse(uri), content, updatedAt: NOW, ...init });
}

function directory(uri: string, init: Partial<DirectoryInit> = {}): Directory {
  return new Directory({ uri: Uri.parse(uri), updatedAt: NOW, ...init });
}

function expectInvalidArgument(run: () => void): ComemError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ComemError);
  const error = caught as ComemError;
  expect(error.code).toBe('INVALID_ARGUMENT');
  return error;
}

describe('stableDigest', () => {
  it('相同输入得到相同输出', () => {
    expect(stableDigest('用户偏好 TypeScript 严格模式')).toBe(
      stableDigest('用户偏好 TypeScript 严格模式'),
    );
  });

  it('不同输入得到不同输出', () => {
    expect(stableDigest('alpha')).not.toBe(stableDigest('beta'));
    expect(stableDigest('alpha')).not.toBe(stableDigest('alpha '));
  });

  it('空串也有值，且是定长十六进制', () => {
    const digest = stableDigest('');

    expect(digest).not.toBe('');
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
  });

  it('emoji 与组合字符可区分', () => {
    expect(stableDigest('😀')).not.toBe(stableDigest('😁'));
    expect(stableDigest('e\u0301')).not.toBe(stableDigest('\u00e9'));
  });
});

describe('Document', () => {
  it('默认 status 是 active，memoryType 是 null', () => {
    const node = document('comem://user/alice/memories/preferences/code-style', '# 代码风格');

    expect(node.kind).toBe('document');
    expect(node.status).toBe('active');
    expect(node.memoryType).toBeNull();
    expect(node.frontmatter).toEqual({});
    expect(node.name).toBe('code-style');
    expect(node.isDirectory).toBe(false);
  });

  it('digest 随正文变化，正文不变时不传播', () => {
    const before = document('comem://user/alice/memories/a', '正文');

    expect(document('comem://user/alice/memories/a', '正文').digest()).toBe(before.digest());
    expect(document('comem://user/alice/memories/a', '正文（改）').digest()).not.toBe(
      before.digest(),
    );
  });

  it('size 按 UTF-8 字节计', () => {
    expect(document('comem://user/alice/memories/a', 'abc').size()).toBe(3);
    expect(document('comem://user/alice/memories/a', '你好').size()).toBe(6);
    expect(document('comem://user/alice/memories/a', '😀').size()).toBe(4);
    expect(document('comem://user/alice/memories/a', '').size()).toBe(0);
  });

  it('保留 frontmatter 与 memoryType', () => {
    const node = document('comem://user/alice/memories/preferences/code-style', '正文', {
      memoryType: 'preferences',
      frontmatter: { summary: '摘要', summaryDigest: 'abc', summaryState: 'stale' },
    });

    expect(node.memoryType).toBe('preferences');
    expect(node.frontmatter.summaryState).toBe('stale');
  });
});

describe('Directory', () => {
  it('新增、查询、删除直接子节点', () => {
    const root = directory('comem://user/alice/memories');
    const child = document('comem://user/alice/memories/profile', '画像');

    root.addChild(child);

    expect(root.children.size).toBe(1);
    expect(root.getChild('profile')).toBe(child);
    expect(root.size()).toBe(1);
    expect(root.isDirectory).toBe(true);

    expect(root.removeChild('profile')).toBe(true);
    expect(root.removeChild('profile')).toBe(false);
    expect(root.getChild('profile')).toBeUndefined();
  });

  it('按种类过滤子节点', () => {
    const root = directory('comem://user/alice/memories', {
      children: [
        document('comem://user/alice/memories/profile', '画像'),
        directory('comem://user/alice/memories/preferences'),
      ],
    });

    expect(root.childrenOfKind('document').map((node) => node.name)).toEqual(['profile']);
    expect(root.childrenOfKind('directory').map((node) => node.name)).toEqual(['preferences']);
  });

  it('目录的 digest 取 L0 摘要正文', () => {
    const summary = { abstract: '一句话摘要', overview: '概览', degraded: false };
    const node = directory('comem://user/alice/memories', { summary });

    expect(node.digest()).toBe(stableDigest('一句话摘要'));
  });

  it('默认摘要为空、新鲜度无基线', () => {
    const node = directory('comem://user/alice/memories');

    expect(node.summary).toEqual({ abstract: '', overview: '', degraded: false });
    expect(node.freshness).toEqual({ baseline: null, pendingChanges: 0, totalEntries: 0 });
  });

  it('根节点不能作为子节点', () => {
    const node = directory('comem://user/alice/memories');
    const root = directory('comem://user/alice');

    expectInvalidArgument(() => {
      node.addChild(root);
    });
  });

  it('子节点的父路径必须与本目录一致', () => {
    const node = directory('comem://user/alice/memories');
    const stranger = document('comem://user/alice/resources/doc', '正文');

    expectInvalidArgument(() => {
      node.addChild(stranger);
    });
  });
});
