import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 单元测试在 tests/unit，适配层集成测试在 tests/integration。
    // 架构文档 §5：tests/unit 是领域层纯函数，tests/integration 用临时目录 + 内存 SQLite。
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // 数据库集成测试会创建临时文件，串行执行避免相互干扰。
    fileParallelism: false,
  },
});
