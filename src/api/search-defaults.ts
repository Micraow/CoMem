/**
 * 检索类入口的默认条数（架构文档 §8.4、§13.2）。
 *
 * 值定义在 `services/search.ts` 的 `DEFAULT_SEARCH_LIMIT`：`services/` 不能 import
 * `api/`（§4.2），而服务层与两个入口必须共用同一个数。这个文件只是给 `api/` 的
 * 出口一个稳定的导入路径，不再重复定义。
 */
export { DEFAULT_SEARCH_LIMIT } from '../services/search.js';
