import { describe, expect, it } from 'vitest';

import { readPromptDefault } from '../../../../src/config/prompt-defaults.js';
import { casesMemoryType } from '../../../../src/domain/memory-types/cases.js';
import { eventsMemoryType } from '../../../../src/domain/memory-types/events.js';
import { preferencesMemoryType } from '../../../../src/domain/memory-types/preferences.js';

describe('案例记忆的类型路由', () => {
  it('cases 保存具体任务的尝试和结果，并允许无价值任务跳过', () => {
    expect(casesMemoryType.directory).toBe('memories/cases');
    expect(casesMemoryType.filename).toBe('{case}.md');
    expect(casesMemoryType.fields.map(({ name }) => name)).toEqual([
      'case',
      'content',
      'updatedAt',
    ]);
    expect(casesMemoryType.description).toContain('具体任务案例');
    expect(casesMemoryType.description).toContain('实际尝试');
    expect(casesMemoryType.description).toContain('观察结果');
    expect(casesMemoryType.description).toContain('## 尝试');
    expect(casesMemoryType.description).toContain('## 结果');
    expect(casesMemoryType.description).toContain('不写记忆');
  });

  it('preferences 与 events 不再承接一次题解和完整执行过程', () => {
    expect(preferencesMemoryType.description).toContain('跨会话稳定选择');
    expect(preferencesMemoryType.description).toContain('一次题解');
    expect(eventsMemoryType.description).toContain('真实发生');
    expect(eventsMemoryType.description).toContain('解题步骤');
  });

  it('抽取提示词要求一次性有证据的任务写 cases，无价值计算留在原会话', () => {
    const prompt = readPromptDefault('extract-system');
    expect(prompt).toContain('写 `cases`');
    expect(prompt).toContain('原会话已经保存');
    expect(prompt).toContain('不要从一次行为推断稳定偏好');
    expect(prompt).toContain('抽取阶段不输出');
  });

  it('手动整理不得把 cases 改写成经验、偏好或事件', () => {
    const prompt = readPromptDefault('consolidation-system');
    expect(prompt).toContain('`cases` 是具体任务的尝试与结果');
    expect(prompt).toContain('删除或更新前必须读取所有相关案例');
    expect(prompt).toContain('`experiences` 只能保存跨案例可复用的做法');
  });
});
