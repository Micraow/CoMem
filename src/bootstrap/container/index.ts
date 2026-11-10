/**
 * 装配模块的对外门面。
 *
 * 实现按依赖域拆在同目录下：
 *
 * | 文件 | 职责 |
 * |---|---|
 * | `assemble.ts` | `createContainer`：按顺序调各阶段，组装 `Container` 与关闭序列 |
 * | `foundation.ts` | 配置 / 日志 / 数据库 / 适配器 / 仓储 |
 * | `models.ts` | 对话、嵌入、重排供应商与服务 |
 * | `access.ts` | 身份、认证、ACL 服务图与用户命名空间预置 |
 * | `retrieval.ts` | 摘要、装配器、观察者、文件系统、账本、任务、会话、检索 |
 * | `memory.ts` | 记忆服务、合并、资源、对账、技能 |
 * | `commit.ts` | 阶段二提交器与五个步骤 |
 * | `background.ts` | 记忆 TTL、调度器、健康观测 |
 * | `api.ts` | MCP 注册表与服务端、服务门面、HTTP 路由、管理面统计 |
 * | `ports.ts` | 临时上传存储与写路径授权 |
 * | `support.ts` | 路径、常量、选项读取与启动自检 |
 * | `types.ts` | `Container` / `ContainerServices` / `CreateContainerOptions` |
 *
 * 对外符号与拆分前逐字一致；调用方 import 的仍然是 `bootstrap/container.js`。
 */

export { createContainer } from './assemble.js';
export { FileResourceStorage, InheritingAuthorizer } from './ports.js';
export { assertDataDirWritable, llmBaseUrlIsPlaceholder } from './support.js';
export type { Container, ContainerServices, CreateContainerOptions } from './types.js';
