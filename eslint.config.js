import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// 分层依赖规则（架构文档 §4.2、§4.3）。
// 这些规则不是风格偏好：领域层一旦 import IO，ACL 求值就没法用内存数据穷举测试。
// 越界 import 一律报 error，并且 allowTypeImports 默认 false——`import type` 同样算依赖。

const DOMAIN_MESSAGE =
  'domain/ 是领域层，只能 type import zod。任何 IO、协议、适配器与其它层的依赖都必须挡在层外（架构文档 §4.2、§4.3）。';
const SERVICES_MESSAGE =
  'services/ 是应用层，只能依赖 domain/。禁止依赖 api/ adapters/ bootstrap/，禁止直接使用 node:fs*、node:sqlite、fetch、ai、@ai-sdk/*（架构文档 §4.2）。';
const API_MESSAGE =
  'api/ 是接口层，只做协议转换。禁止依赖 adapters/ 与 bootstrap/——具体技术实现通过构造参数注入（架构文档 §4.1、§4.2）。';
const ADAPTERS_MESSAGE =
  'adapters/ 是适配层，只能依赖 domain/。禁止依赖 api/ services/ bootstrap/（架构文档 §4.2）。';

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'dist/**', 'local/**', 'docs/**', 'web/**', 'integrations/**'],
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
                '**/adapters/**',
                '**/bootstrap/**',
              ],
              message: SERVICES_MESSAGE,
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
