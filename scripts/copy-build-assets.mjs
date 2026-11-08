// 构建产物里的非 TypeScript 资源。
//
// `tsc` 只输出 `.js`，而 SQLite 迁移是 `.sql`：`database.ts` 用
// `new URL('./migrations', import.meta.url)` 定位它们，所以 `dist/` 里必须有同一份。
// 漏复制的表现是启动时报 ENOENT（目录不存在），而不是「少一张表」。
import { cpSync, mkdirSync } from 'node:fs';

const source = new URL('../src/adapters/sqlite/migrations/', import.meta.url);
const target = new URL('../dist/adapters/sqlite/migrations/', import.meta.url);

mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
