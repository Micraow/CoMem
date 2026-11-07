import { describe, expect, it } from 'vitest';

import { ComemError } from '../../src/domain/errors.js';
import { Uri } from '../../src/domain/uri.js';

function expectInvalidUri(input: string, currentUserId?: string): ComemError {
  let caught: unknown;
  try {
    Uri.parse(input, currentUserId === undefined ? {} : { currentUserId });
  } catch (error) {
    caught = error;
  }
  expect(caught, `期望 ${JSON.stringify(input)} 被拒绝`).toBeInstanceOf(ComemError);
  const error = caught as ComemError;
  expect(error.code).toBe('INVALID_URI');
  return error;
}

describe('Uri.parse', () => {
  it('拆出 scope、rootId 与段', () => {
    const uri = Uri.parse('comem://user/alice/memories/foo');

    expect(uri.scope).toBe('user');
    expect(uri.rootId).toBe('alice');
    expect(uri.segments).toEqual(['memories', 'foo']);
    expect(uri.depth).toBe(2);
    expect(uri.name).toBe('foo');
    expect(uri.isRoot).toBe(false);
    expect(uri.toString()).toBe('comem://user/alice/memories/foo');
    expect(uri.toStringAsDirectory()).toBe('comem://user/alice/memories/foo/');
  });

  it('接受 group 根', () => {
    const uri = Uri.parse('comem://group/eng/memories/foo');

    expect(uri.scope).toBe('group');
    expect(uri.rootId).toBe('eng');
    expect(uri.toString()).toBe('comem://group/eng/memories/foo');
  });

  it('根节点没有段，name 为空串', () => {
    const uri = Uri.parse('comem://user/alice');

    expect(uri.isRoot).toBe(true);
    expect(uri.depth).toBe(0);
    expect(uri.name).toBe('');
    expect(uri.segments).toEqual([]);
    expect(uri.toString()).toBe('comem://user/alice');
    expect(uri.toStringAsDirectory()).toBe('comem://user/alice/');
  });

  it('scheme 大小写不敏感', () => {
    expect(Uri.parse('COMEM://user/alice').toString()).toBe('comem://user/alice');
    expect(Uri.parse('CoMeM://group/eng').toString()).toBe('comem://group/eng');
  });

  it('rootId 允许邮箱字符集 [A-Za-z0-9._@-]', () => {
    for (const rootId of ['alice', 'alice@example.com', 'alice.smith', 'alice_smith', 'a-b', 'A1']) {
      expect(Uri.parse(`comem://user/${rootId}`).rootId).toBe(rootId);
    }
  });

  describe('规范化（§6.2）', () => {
    it('段做 NFC 规范化：组合字符与预组合字符得到同一个 Uri', () => {
      const decomposed = Uri.parse('comem://user/alice/cafe\u0301');
      const composed = Uri.parse('comem://user/alice/café');

      expect(decomposed.segments).toEqual(['café']);
      expect(decomposed.equals(composed)).toBe(true);
      expect(decomposed.toString()).toBe(composed.toString());
    });

    it('合并重复斜杠', () => {
      expect(Uri.parse('comem://user/alice//memories///foo').segments).toEqual(['memories', 'foo']);
    });

    it('丢弃末尾斜杠，不进入 identity', () => {
      const withSlash = Uri.parse('comem://user/alice/memories/');
      const withoutSlash = Uri.parse('comem://user/alice/memories');

      expect(withSlash.segments).toEqual(['memories']);
      expect(withSlash.equals(withoutSlash)).toBe(true);
      expect(withSlash.toString()).toBe('comem://user/alice/memories');
    });

    it('根节点的末尾斜杠同样被丢弃', () => {
      expect(Uri.parse('comem://user/alice/').equals(Uri.parse('comem://user/alice'))).toBe(true);
    });
  });

  describe('拒绝非法输入（§6.2 规则 3–10）', () => {
    it('拒绝 . 与 .. 段', () => {
      expectInvalidUri('comem://user/alice/./foo');
      expectInvalidUri('comem://user/alice/memories/..');
      expectInvalidUri('comem://user/alice/..');
    });

    it('拒绝控制字符与反斜杠', () => {
      expectInvalidUri('comem://user/alice/a\u0000b');
      expectInvalidUri('comem://user/alice/a\u001fb');
      expectInvalidUri('comem://user/alice/a\nb');
      expectInvalidUri('comem://user/alice/a\\b');
    });

    it('拒绝超过 255 字节的单段', () => {
      expect(() => Uri.parse(`comem://user/alice/${'a'.repeat(255)}`)).not.toThrow();
      expectInvalidUri(`comem://user/alice/${'a'.repeat(256)}`);
      // 多字节字符按 UTF-8 字节数算：'é' 是 2 字节
      expect(() => Uri.parse(`comem://user/alice/${'é'.repeat(127)}`)).not.toThrow();
      expectInvalidUri(`comem://user/alice/${'é'.repeat(128)}`);
    });

    it('拒绝保留名作为普通段', () => {
      for (const reserved of [
        '.abstract.md',
        '.overview.md',
        '.acl.json',
        '.meta.json',
        '.done',
        'memory_diff.json',
      ]) {
        expectInvalidUri(`comem://user/alice/${reserved}`);
        expectInvalidUri(`comem://user/alice/memories/${reserved}`);
      }
    });

    it('只认 comem scheme', () => {
      expectInvalidUri('http://user/alice/memories');
      expectInvalidUri('comem:/user/alice/memories');
      expectInvalidUri('comem//user/alice');
      expectInvalidUri('user/alice/memories');
    });

    it('scope 只接受 user 与 group', () => {
      expectInvalidUri('comem://USER/alice');
      expectInvalidUri('comem://team/eng/memories');
      expectInvalidUri('comem://alice/memories');
    });

    it('拒绝空段与缺失的根标识', () => {
      // §6.2 规则 10：根标识位置必须是实段，不能靠合并斜杠补出来
      expectInvalidUri('comem://user//a');
      expectInvalidUri('comem://user/');
      expectInvalidUri('comem://user');
      expectInvalidUri('comem://');
      expectInvalidUri('');
    });

    it('rootId 超出字符集时拒绝', () => {
      expectInvalidUri('comem://user/al ice');
      expectInvalidUri('comem://user/alic e/memories');
      // 通过百分号编码的路径不在这里解码，% 本身不合法
      expectInvalidUri('comem://user/%61lice');
    });

    it('错误里带 input 与 reason', () => {
      const error = expectInvalidUri('comem://user/alice/..');

      expect(error.details).toEqual({
        input: 'comem://user/alice/..',
        reason: '路径段不能是 ..',
      });
      expect(error.message).toContain('URI 不合法');
    });
  });

  describe('~ 别名（§6.1）', () => {
    it('展开成 user/{currentUserId}', () => {
      expect(Uri.parse('comem://~', { currentUserId: 'alice' }).toString()).toBe('comem://user/alice');
      expect(Uri.parse('comem://~/memories/foo', { currentUserId: 'alice' }).toString()).toBe(
        'comem://user/alice/memories/foo',
      );
    });

    it('展开结果与显式写法相等', () => {
      const expanded = Uri.parse('comem://~/memories/foo', { currentUserId: 'alice' });
      const explicit = Uri.parse('comem://user/alice/memories/foo');

      expect(expanded.equals(explicit)).toBe(true);
      expect(expanded.scope).toBe('user');
    });

    it('没有 currentUserId 时拒绝', () => {
      expectInvalidUri('comem://~');
      expectInvalidUri('comem://~/memories');
    });

    it('只认第一段：其余位置的 ~ 按普通段处理', () => {
      // 根标识位置的 ~ 不是别名，且 `~` 不在 rootId 字符集里
      expectInvalidUri('comem://user/~/memories');
      // 普通段里的 ~ 合法
      expect(Uri.parse('comem://user/alice/~memo').segments).toEqual(['~memo']);
    });

    it('currentUserId 本身也要合法', () => {
      expectInvalidUri('comem://~', '');
      expectInvalidUri('comem://~', 'al ice');
      expectInvalidUri('comem://~', 'alice/foo');
    });
  });
});

describe('Uri.tryParse', () => {
  it('合法输入返回 Uri', () => {
    expect(Uri.tryParse('comem://user/alice/memories')?.name).toBe('memories');
  });

  it('非法输入返回 null 而不抛', () => {
    expect(Uri.tryParse('comem://user//a')).toBeNull();
    expect(Uri.tryParse('comem://user/alice/..')).toBeNull();
    expect(Uri.tryParse('')).toBeNull();
  });
});

describe('Uri 导航', () => {
  const root = Uri.parse('comem://user/alice');
  const memories = Uri.parse('comem://user/alice/memories');
  const foo = Uri.parse('comem://user/alice/memories/foo');

  it('parent() 逐级上溯，根节点返回 null', () => {
    expect(foo.parent()?.toString()).toBe('comem://user/alice/memories');
    expect(memories.parent()?.toString()).toBe('comem://user/alice');
    expect(root.parent()).toBeNull();
  });

  it('child() 逐段追加并校验', () => {
    expect(root.child('memories').toString()).toBe('comem://user/alice/memories');
    expect(root.child('memories', 'foo').toString()).toBe('comem://user/alice/memories/foo');
    expect(root.child().equals(root)).toBe(true);
  });

  it('child() 对非法段抛 INVALID_URI', () => {
    for (const name of ['', '.', '..', 'a/b', 'a\\b', 'a\u0000b', '.done']) {
      expect(() => root.child(name), `期望 ${JSON.stringify(name)} 被拒绝`).toThrow(ComemError);
    }
    expect(() => root.child('a'.repeat(256))).toThrow(ComemError);
  });
});

describe('Uri 比较', () => {
  it('equals 只比较 scope、rootId 与规范化后的段', () => {
    expect(Uri.parse('comem://user/alice/memories').equals(Uri.parse('comem://user/alice/memories/'))).toBe(
      true,
    );
    expect(Uri.parse('comem://user/alice').equals(Uri.parse('comem://group/alice'))).toBe(false);
    expect(Uri.parse('comem://user/alice').equals(Uri.parse('comem://user/bob'))).toBe(false);
    expect(Uri.parse('comem://user/alice/a').equals(Uri.parse('comem://user/alice/a/b'))).toBe(false);
  });

  it('isAncestorOf 是严格前缀，自身不算', () => {
    const root = Uri.parse('comem://user/alice');
    const child = Uri.parse('comem://user/alice/memories');
    const grandChild = Uri.parse('comem://user/alice/memories/foo');

    expect(root.isAncestorOf(child)).toBe(true);
    expect(root.isAncestorOf(grandChild)).toBe(true);
    expect(child.isAncestorOf(grandChild)).toBe(true);

    expect(root.isAncestorOf(root)).toBe(false);
    expect(child.isAncestorOf(root)).toBe(false);
    expect(root.isAncestorOf(Uri.parse('comem://user/alice2'))).toBe(false);
    expect(root.isAncestorOf(Uri.parse('comem://group/alice/memories'))).toBe(false);
  });
});

describe('项目维度（§6.3）', () => {
  it('projectId 取 projects 段后的 ID', () => {
    expect(Uri.parse('comem://user/alice/projects/comem').projectId).toBe('comem');
    expect(Uri.parse('comem://user/alice/projects/comem/memories').projectId).toBe('comem');
  });

  it('不在项目路径下时为 null', () => {
    expect(Uri.parse('comem://user/alice').projectId).toBeNull();
    expect(Uri.parse('comem://user/alice/memories').projectId).toBeNull();
    expect(Uri.parse('comem://user/alice/projects').projectId).toBeNull();
  });

  it('isProject 只认 projects/{pid}', () => {
    expect(Uri.parse('comem://user/alice/projects/comem').isProject).toBe(true);
    expect(Uri.parse('comem://group/eng/projects/comem').isProject).toBe(true);
    expect(Uri.parse('comem://user/alice/projects/comem/memories').isProject).toBe(false);
    expect(Uri.parse('comem://user/alice/projects').isProject).toBe(false);
    expect(Uri.parse('comem://user/alice/memories/comem').isProject).toBe(false);
  });
});
