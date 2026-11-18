/**
 * 组命名空间的目录初始化与自愈。
 *
 * 组根 ACL 只能由 `AclService.ensureRootPreset` 写；物理目录和派生索引又必须等
 * `IndexObserver` 构造完成后才能维护。本服务因此放在检索栈里，同时供启动扫描、
 * 管理面建组和请求身份解析使用，避免三处各写一遍目录列表。
 */

import type { ContentStore } from '../adapters/fs/content-store.js';
import type { Group } from '../domain/identity.js';
import type { Logger } from '../domain/log.js';
import { Uri } from '../domain/uri.js';

import type { AclService } from './acl.js';
import type { NodeWriteObserver } from './filesystem.js';

const GROUP_DIRECTORIES = ['memories', 'resources', 'projects'] as const;

export interface GroupNamespaceDeps {
  readonly store: ContentStore;
  readonly acl: Pick<AclService, 'ensureRootPreset'>;
  readonly observer: Pick<NodeWriteObserver, 'onNodeWritten'>;
  readonly logger: Logger;
}

export class GroupNamespaceService {
  readonly #deps: GroupNamespaceDeps;
  readonly #ready = new Set<string>();

  constructor(deps: GroupNamespaceDeps) {
    this.#deps = deps;
  }

  /**
   * 确保一个组的根、基础目录、索引和权限都存在。
   *
   * 已完成的组在每次请求里只做一次根和基础目录的 `stat` 检查；外部删掉任一目录后
   * 会重新走完整初始化。这样既有热点请求没有持续写放大，也能在访问时自愈。
   */
  async ensure(group: Pick<Group, 'id' | 'ownerUserId'>): Promise<void> {
    const root = Uri.parse(`comem://group/${group.id}`);
    const directories = [root, ...GROUP_DIRECTORIES.map((name) => root.child(name))];

    if (this.#ready.has(group.id)) {
      let intact = true;
      for (const directory of directories) {
        if ((await this.#deps.store.stat(directory)) === null) {
          intact = false;
          break;
        }
      }
      if (intact) {
        return;
      }
      this.#ready.delete(group.id);
    }

    await this.#deps.acl.ensureRootPreset(root, group.ownerUserId);
    for (const directory of directories) {
      await this.#deps.store.mkdir(directory, { recursive: true });
    }
    for (const directory of directories) {
      await this.#deps.observer.onNodeWritten(directory, 'directory');
    }
    this.#ready.add(group.id);
    this.#deps.logger.info('组命名空间已初始化', {
      groupId: group.id,
      directories: directories.map((directory) => directory.toString()),
    });
  }

  async ensureAll(groups: readonly Pick<Group, 'id' | 'ownerUserId'>[]): Promise<void> {
    for (const group of groups) {
      await this.ensure(group);
    }
  }

  /** 组行被删除后丢弃进程内状态，同 ID 重建时必须重新写根预置。 */
  invalidate(groupId: string): void {
    this.#ready.delete(groupId);
  }
}
