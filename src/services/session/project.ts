/**
 * 会话与项目绑定的持久化规则。
 *
 * 绑定只改 live 会话的 `.meta.json`，消息、归档计数和归档内容都保持不变。所有
 * 读改写入口都应在会话 `TREE` 锁内调用 `ensureProjectBinding`；公开的
 * `bindProject` 只为独立端点取锁。
 */

import { ComemError } from '../../domain/errors.js';
import { projectScopeOf } from '../../domain/project.js';
import type { SessionMeta } from '../../domain/session.js';
import type { Uri } from '../../domain/uri.js';

import { notifyNodeWritten } from './hooks.js';
import type { SessionPorts } from './ports.js';
import { requireSession } from './storage.js';

export interface SessionProjectBinding {
  readonly sessionUri: Uri;
  readonly projectId: string;
  readonly projectScopeUri: Uri;
}

export interface ProjectBindingResult {
  readonly meta: SessionMeta;
  readonly projectId?: string;
  readonly projectScopeUri?: Uri;
}

function sessionScopeOf(sessionUri: Uri): Uri {
  const sessionsDirectory = sessionUri.parent();
  const scope = sessionsDirectory?.parent();
  if (sessionsDirectory?.name !== 'sessions' || scope === null || scope === undefined) {
    throw new ComemError(
      'INVALID_ARGUMENT',
      `会话 URI 必须是根下的 sessions/{id}：${sessionUri.toString()}`,
      { uri: sessionUri.toString() },
    );
  }
  return scope;
}

/** 单个已校验项目 ID 对应的个人项目 scope。 */
export function projectBindingOf(
  sessionUri: Uri,
  projectId: string,
): SessionProjectBinding {
  const projectScopeUri = projectScopeOf(sessionScopeOf(sessionUri), projectId);
  return {
    sessionUri,
    projectId: projectScopeUri.name,
    projectScopeUri,
  };
}

/**
 * 建立项目作用域的固定目录。
 *
 * 文件树读的是磁盘目录，再按 `node_permission` 过滤。项目目录若等到阶段二提交才
 * 创建，用户刚把会话绑定到项目时会在树里完全看不到它。这里统一建立并通知
 * 观察者，让创建、补绑和后续追加消息都收敛到同一套目录结构。
 */
export async function prepareProjectScope(
  ports: SessionPorts,
  projectScopeUri: Uri,
): Promise<void> {
  const projectsDirectory = projectScopeUri.parent();
  if (projectsDirectory?.name !== 'projects') {
    throw new ComemError(
      'INVALID_ARGUMENT',
      `项目目录必须是个人根下的 projects/{id}：${projectScopeUri.toString()}`,
      { projectScopeUri: projectScopeUri.toString() },
    );
  }

  const directories = [
    projectsDirectory,
    projectScopeUri,
    projectScopeUri.child('memories'),
    projectScopeUri.child('resources'),
  ] as const;
  for (const directory of directories) {
    await ports.store.mkdir(directory, { recursive: true });
  }
  for (const directory of directories) {
    await notifyNodeWritten(ports, directory, 'directory');
  }
}

/**
 * 在一个已经持有会话 `TREE` 锁的读写路径中确保 projectId 一致。
 *
 * `requestedProjectId` 缺省时不主动绑定；已有绑定原样返回。已有绑定与请求不同
 * 时返回 409 `CONFLICT`，不会把后续归档静默改到另一个项目。
 */
export async function ensureProjectBinding(
  ports: SessionPorts,
  sessionUri: Uri,
  meta: SessionMeta,
  requestedProjectId?: string,
): Promise<ProjectBindingResult> {
  if (requestedProjectId === undefined) {
    if (meta.projectId === undefined) {
      return { meta };
    }
    const binding = projectBindingOf(sessionUri, meta.projectId);
    // 修复旧版本只落 projectId、尚未创建目录的会话；幂等，重复写入只做 stat/upsert。
    await prepareProjectScope(ports, binding.projectScopeUri);
    return {
      meta,
      projectId: binding.projectId,
      projectScopeUri: binding.projectScopeUri,
    };
  }

  const binding = projectBindingOf(sessionUri, requestedProjectId);
  if (meta.projectId !== undefined && meta.projectId !== binding.projectId) {
    throw new ComemError(
      'CONFLICT',
      `会话已绑定项目 ${meta.projectId}，不能改为 ${binding.projectId}。`,
      {
        uri: sessionUri.toString(),
        existingProjectId: meta.projectId,
        projectId: binding.projectId,
      },
    );
  }

  await prepareProjectScope(ports, binding.projectScopeUri);
  const nextMeta =
    meta.projectId === binding.projectId ? meta : { ...meta, projectId: binding.projectId };
  if (nextMeta !== meta) {
    await ports.meta.writeSession(sessionUri, nextMeta);
    ports.logger.info('会话项目已绑定', {
      uri: sessionUri.toString(),
      projectId: binding.projectId,
    });
  }
  return {
    meta: nextMeta,
    projectId: binding.projectId,
    projectScopeUri: binding.projectScopeUri,
  };
}

/** 独立绑定入口；只改元数据，不读也不重写消息。 */
export async function bindProject(
  ports: SessionPorts,
  sessionUri: Uri,
  projectId: string,
): Promise<SessionProjectBinding> {
  return ports.locks.withLock(sessionUri, 'tree', async () => {
    const meta = await requireSession(ports.meta, sessionUri);
    await ensureProjectBinding(ports, sessionUri, meta, projectId);
    return projectBindingOf(sessionUri, projectId);
  });
}
