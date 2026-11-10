import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// 分层依赖规则（架构文档 §4.2、§4.3）。
// 这些规则不是风格偏好：领域层一旦 import IO，ACL 求值就没法用内存数据穷举测试。
// 越界 import 一律报 error，并且 allowTypeImports 默认 false——`import type` 同样算依赖。

const DOMAIN_MESSAGE =
  'domain/ 是领域层，只能 type import zod。任何 IO、协议、适配器与其它层的依赖都必须挡在层外（架构文档 §4.2、§4.3）。';
const SERVICES_MESSAGE =
  'services/ 是应用层，只能依赖 domain/。禁止依赖 api/ bootstrap/，禁止直接使用 node:fs*、node:sqlite、fetch、ai、@ai-sdk/*（架构文档 §4.2）。';
const SERVICES_ADAPTERS_MESSAGE =
  'services/ 只能用 `import type` 引用 adapters/ 的具体类型；值导入禁止。实例一律由 bootstrap 构造注入，services/ 不 new 适配器（架构文档 §4.2、§4.4）。';
const API_MESSAGE =
  'api/ 是接口层，只做协议转换。禁止依赖 adapters/ 与 bootstrap/——具体技术实现通过构造参数注入（架构文档 §4.1、§4.2）。';
const ADAPTERS_MESSAGE =
  'adapters/ 是适配层，只能依赖 domain/。禁止依赖 api/ services/ bootstrap/（架构文档 §4.2）。';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'local/**',
      // local-inference/ 是 Python + vendored llama.cpp 源码 + 构建产物（.venv / models），
      // 没有任何 JS/TS。不放进来时 eslint 会去扫 .venv 里的 site-packages 与
      // llama.cpp 的 C++ 头文件，报几百个 no-undef。
      'local-inference/**',
      'docs/**',
      'web/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },
  {
    // 纯 `.mjs` 脚本（`scripts/`、`integrations/`）跑在 Node 里，不是浏览器。
    //
    // `tseslint.configs.recommended` 只为 TypeScript 关掉 `no-undef`（类型检查
    // 已经覆盖它），`.mjs` 拿不到这层豁免，又没声明 Node 全局，于是 `process` /
    // `fetch` / `setTimeout` 全部报未定义。这不是代码问题，是配置缺口。
    //
    // `integrations/tests/` 用 `node --test` 且从 `node:test` 显式 import
    // `test`，不需要测试运行器的 `describe` / `it` 全局；它需要的只是 Node 全局。
    // `performance` 自 Node 16、`Response` 自 Node 18 起是全局（engines 要求
    // Node >=22.5），不是测试专属 API。
    //
    // `globals` 包没装（少一个依赖），手列 v1 用到的集合；新增全局时在这里补。
    files: ['scripts/**/*.mjs', 'integrations/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        queueMicrotask: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        structuredClone: 'readonly',
        performance: 'readonly',
        Response: 'readonly',
      },
    },
  },
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'zod',
              message: 'domain/ 只能用 `import type` 引入 zod 的类型。',
              allowTypeImports: true,
            },
          ],
          patterns: [
            {
              group: [
                'node:*',
                'node',
                'fastify',
                'ai',
                '@ai-sdk/*',
                '**/api/**',
                '**/services/**',
                '**/adapters/**',
                '**/bootstrap/**',
                '**/config/**',
              ],
              message: DOMAIN_MESSAGE,
            },
          ],
        },
      ],
      'no-restricted-globals': ['error', { name: 'fetch', message: DOMAIN_MESSAGE }],
    },
  },
  {
    files: ['src/services/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'node:fs',
                'node:fs/*',
                'node:sqlite',
                'ai',
                '@ai-sdk/*',
                '**/api/**',
                '**/bootstrap/**',
              ],
              message: SERVICES_MESSAGE,
            },
            {
              // §4.4 明确不为 ContentStore 之类只做一个实现的类型建接口，
              // 所以 services/ 只能引用 adapters/ 的具体类型。放开的是**类型**依赖，
              // 运行期实例仍由 bootstrap 构造注入——这一条不是风格，是可测性与装配边界。
              group: ['**/adapters/**'],
              allowTypeImports: true,
              message: SERVICES_ADAPTERS_MESSAGE,
            },
          ],
        },
      ],
      'no-restricted-globals': ['error', { name: 'fetch', message: SERVICES_MESSAGE }],
    },
  },
  {
    files: ['src/api/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/adapters/**', '**/bootstrap/**'],
              message: API_MESSAGE,
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/adapters/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/api/**', '**/services/**', '**/bootstrap/**'],
              message: ADAPTERS_MESSAGE,
            },
          ],
        },
      ],
    },
  },
);
