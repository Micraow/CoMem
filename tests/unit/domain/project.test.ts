import { describe, expect, it } from 'vitest';

import {
  memoryScope,
  normalizeProjectId,
  projectScopeOf,
} from '../../../src/domain/project.js';
import { Uri } from '../../../src/domain/uri.js';

const PERSONAL = Uri.parse('comem://user/alice');

describe('project scope', () => {
  it('projectId 是单路径段并做 NFC 规范化', () => {
    expect(normalizeProjectId('cafe\u0301')).toBe('café');
    for (const invalid of ['', '.', '..', 'a/b', 'a\\b', 'line\nbreak', '.meta.json']) {
      expect(() => normalizeProjectId(invalid)).toThrow();
    }
  });

  it('只允许个人根下的直接项目作用域', () => {
    expect(projectScopeOf(PERSONAL, 'comem').toString()).toBe(
      'comem://user/alice/projects/comem',
    );
    expect(() => projectScopeOf(Uri.parse('comem://group/eng'), 'comem')).toThrow();
    expect(() =>
      projectScopeOf(Uri.parse('comem://user/alice/projects/existing'), 'comem'),
    ).toThrow();
  });

  it('项目内容使用项目 scope，个人画像和偏好使用个人根', () => {
    const project = projectScopeOf(PERSONAL, 'comem');
    for (const type of ['entities', 'events', 'cases', 'experiences', 'rules']) {
      expect(memoryScope(type, PERSONAL, project)).toBe(project);
    }
    for (const type of ['profile', 'preferences', 'identity', 'soul']) {
      expect(memoryScope(type, PERSONAL, project)).toBe(PERSONAL);
    }
    expect(memoryScope('experiences', PERSONAL)).toBe(PERSONAL);
  });
});
