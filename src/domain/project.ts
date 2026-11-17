/**
 * 项目作用域与记忆类型的归属规则（架构文档 §6.3、§6.4）。
 *
 * 项目只存在于 `user/{uid}/projects/{pid}` 这一级。会话原文仍属于个人根，
 * `projectId` 只是一个已校验的单路径段，不是可拼接的 URI 片段。
 */

import { ComemError } from './errors.js';
import type { Uri } from './uri.js';
import { Uri as UriValue } from './uri.js';

const PERSONAL_MEMORY_TYPES: ReadonlySet<string> = new Set([
  'profile',
  'preferences',
  'identity',
  'soul',
]);

const PROJECT_ID_VALIDATOR_ROOT = UriValue.parse('comem://user/project');

/**
 * 校验并规范化项目 ID。
 *
 * 复用 `Uri.child`，因此 NFC、保留名、控制字符、斜杠、`.`、`..` 与 255 字节上限
 * 与所有 `comem://` 路径段保持同一套规则。调用方得到的是可以持久化的规范值。
 */
export function normalizeProjectId(projectId: string): string {
  try {
    const normalized = PROJECT_ID_VALIDATOR_ROOT.child('projects', projectId).name;
    if (normalized === '') {
      throw new Error('empty project id');
    }
    return normalized;
  } catch (error) {
    throw new ComemError(
      'INVALID_ARGUMENT',
      'projectId 必须是单个合法 URI 路径段。',
      { projectId, reason: error instanceof Error ? error.message : String(error) },
    );
  }
}

/** 个人根下的项目作用域；项目 ID 先按单路径段规则规范化。 */
export function projectScopeOf(personalScope: Uri, projectId: string): Uri {
  if (personalScope.scope !== 'user' || !personalScope.isRoot) {
    throw new ComemError(
      'INVALID_ARGUMENT',
      '项目只能绑定在个人根下。',
      { scopeUri: personalScope.toString() },
    );
  }
  return personalScope.child('projects', normalizeProjectId(projectId));
}

/**
 * 记忆类型对应的写入 scope。
 *
 * 画像是用户跨项目的稳定属性；偏好、身份与原则也跟随个人。其余内置内容描述
 * 当前项目里的实体、事件、案例、经验与规则，因此有项目时写到项目根下。
 */
export function memoryScope(type: string, personalScope: Uri, projectScope?: Uri): Uri {
  if (projectScope === undefined) {
    return personalScope;
  }

  const projectsDirectory = personalScope.child('projects');
  if (
    personalScope.scope !== 'user' ||
    !personalScope.isRoot ||
    !projectScope.parent()?.equals(projectsDirectory)
  ) {
    throw new ComemError(
      'INVALID_ARGUMENT',
      'projectScope 必须是个人根的直接项目子作用域。',
      {
        scopeUri: personalScope.toString(),
        projectScopeUri: projectScope.toString(),
      },
    );
  }

  return PERSONAL_MEMORY_TYPES.has(type) ? personalScope : projectScope;
}
