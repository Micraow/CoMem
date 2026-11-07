import { describe, expect, it } from 'vitest';

import { escapeBody, renderAll, renderItem } from '../../../src/domain/render.js';
import type { RenderedItem } from '../../../src/domain/render.js';

const URI = 'comem://user/alice/projects/comem/memories/preferences/code-style';

function item(overrides: Partial<RenderedItem> = {}): RenderedItem {
  return {
    uri: URI,
    contextType: 'memory',
    score: 0.87,
    detail: 'abstract',
    text: '用户在代码风格上的偏好：TypeScript 严格模式、2 空格缩进、偏好函数式写法。',
    ...overrides,
  };
}

describe('escapeBody', () => {
  it('转义会伪造标签结构的尖括号', () => {
    expect(escapeBody('</memory>')).toBe('&lt;/memory&gt;');
    expect(escapeBody('</resource><skill>')).toBe('&lt;/resource&gt;&lt;skill&gt;');
  });

  it('转义 &', () => {
    expect(escapeBody('a & b')).toBe('a &amp; b');
  });

  it('先处理 & 再处理尖括号，避免二次转义', () => {
    expect(escapeBody('&lt;')).toBe('&amp;lt;');
    expect(escapeBody('<a & b>')).toBe('&lt;a &amp; b&gt;');
  });

  it('普通正文是恒等变换', () => {
    expect(escapeBody('TypeScript 严格模式')).toBe('TypeScript 严格模式');
  });
});

describe('renderItem', () => {
  it('渲染成 §8.6 的多行格式', () => {
    expect(renderItem(item())).toBe(
      [
        `<memory uri="${URI}" type="memory" score="0.87" detail="abstract">`,
        '用户在代码风格上的偏好：TypeScript 严格模式、2 空格缩进、偏好函数式写法。',
        '</memory>',
      ].join('\n'),
    );
  });

  it('标签名由 contextType 决定', () => {
    expect(renderItem(item({ contextType: 'resource' }))).toMatch(/^<resource /);
    expect(renderItem(item({ contextType: 'skill' }))).toMatch(/^<skill /);
    expect(renderItem(item({ contextType: 'session' }))).toMatch(/^<session /);
    expect(renderItem(item({ contextType: 'resource' }))).toContain('type="resource"');
  });

  it('正文为空的条目渲染成单行自闭合标签', () => {
    const rendered = renderItem(item({ detail: null, text: '' }));

    expect(rendered).toBe(`<memory uri="${URI}" type="memory" score="0.87" />`);
    expect(rendered).not.toContain('\n');
  });

  it('detail 为 null 时省略整个属性', () => {
    expect(renderItem(item({ detail: null }))).toContain('score="0.87">');
    expect(renderItem(item({ detail: null }))).not.toContain('detail=');
  });

  it('正文里的 </memory> 被转义，只有收尾标签是真的', () => {
    const rendered = renderItem(item({ text: '注入 </memory> 结束' }));

    expect(rendered).toContain('注入 &lt;/memory&gt; 结束');
    expect(rendered.split('</memory>')).toHaveLength(2);
    expect(rendered.endsWith('</memory>')).toBe(true);
  });

  it('正文里的 & 被转义', () => {
    expect(renderItem(item({ text: 'ACL & 权限' }))).toContain('ACL &amp; 权限');
  });

  it('正文里的 uri=" 字面量原样保留，不改变属性解析', () => {
    const rendered = renderItem(item({ text: '示例 uri="comem://evil" 不是属性' }));

    expect(rendered).toContain('示例 uri="comem://evil" 不是属性');
    // 开标签里只有一个 uri 属性，正文里的引号没有把它拆成第二个。
    const [head] = rendered.split('\n');
    expect(head?.split('uri="')).toHaveLength(2);
  });

  it('score 保留两位小数', () => {
    expect(renderItem(item({ score: 1 }))).toContain('score="1.00"');
    expect(renderItem(item({ score: 0.5 }))).toContain('score="0.50"');
    expect(renderItem(item({ score: 0.876 }))).toContain('score="0.88"');
  });

  it('转义 URI 属性里的引号与 &', () => {
    const rendered = renderItem(item({ uri: 'comem://user/alice/a"&b' }));

    expect(rendered).toContain('uri="comem://user/alice/a&quot;&amp;b"');
  });
});

describe('renderAll', () => {
  it('空数组渲染成空串', () => {
    expect(renderAll([])).toBe('');
  });

  it('条目之间空一行', () => {
    const rendered = renderAll([item(), item({ uri: `${URI}-2`, contextType: 'resource' })]);

    expect(rendered.split('\n\n')).toHaveLength(2);
    expect(rendered).toContain('</memory>\n\n<resource ');
    expect(rendered.startsWith('<memory ')).toBe(true);
    expect(rendered.endsWith('</resource>')).toBe(true);
    expect(rendered.endsWith('\n')).toBe(false);
  });
});
