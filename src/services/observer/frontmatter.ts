/**
 * 记忆文件 frontmatter 的字段解析（`memory_type` / `status` / `valid_from` / `valid_until`）。
 *
 * 解析实现只有一份，在 `services/memory/frontmatter.ts`：观察者、`read` 与
 * `reindex` 必须对同一份文件给出同样的状态与有效期，否则「文件里写的是 pending」
 * 在 `read` 里是 pending、在索引里是 active，复核闸门（§11.6）就失效了。
 *
 * 这个文件只保留观察者的最小字段集（`FrontmatterFields`）与对外路径，避免
 * `observer/record.ts` / `services/reconcile.ts` 的导入面跟着解析实现搬家。
 */

export {
  EMPTY_FRONTMATTER_FIELDS,
  parseFrontmatterFields,
  type FrontmatterFields,
} from '../memory/frontmatter.js';
