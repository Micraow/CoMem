/**
 * 优雅退出的关闭序列（`src/bootstrap/main.ts` 的 `shutdownGracefully`）。
 *
 * 这条测试的重点不是 `FileLogger.flush` 本身（`tests/unit/adapters/log.test.ts` 已经
 * 覆盖了队列语义），而是**它真的被放在关闭序列的最后**：前面的组件关闭时写下的
 * 日志，必须在进程退出前落盘。直接调 `logger.flush()` 的测试证明不了这一点——把
 * `main` 里的接线删掉，它照样绿。
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileLogger } from '../../../src/adapters/log/file.js';
import { NullLogger } from '../../helpers/null-logger.js';
import { shutdownGracefully } from '../../../src/bootstrap/main.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'comem-shutdown-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('shutdownGracefully', () => {
  it('按序关闭，最后等日志落盘：退出前队列里的行都在文件里', async () => {
    const dir = await tempDir();
    const filePath = join(dir, 'logs', 'error.log');
    const logger = new FileLogger({ inner: new NullLogger(), filePath });
    const order: string[] = [];

    // 记录 flush 实际被调用，并保留真实实现。只看文件内容不够：`appendFile` 可能
    // 恰好先完成，删掉接线后测试仍会绿。
    const originalFlush = logger.flush.bind(logger);
    vi.spyOn(logger, 'flush').mockImplementation(async () => {
      order.push('flush');
      await originalFlush();
    });
    // 最后一行是 `info`（`FileLogger` 只把 error 落盘），用调用顺序证明 flush 在它之后。
    const originalInfo = logger.info.bind(logger);
    vi.spyOn(logger, 'info').mockImplementation((message, fields) => {
      order.push('exitLog');
      originalInfo(message, fields);
    });

    // 两条关闭前就排队的日志：一条模拟请求错误，一条模拟组件关闭时打的日志。
    logger.error('退出前的第一条');
    logger.error('退出前的第二条');

    await shutdownGracefully(
      {
        server: {
          close: async () => {
            order.push('server');
          },
        },
        commitRunner: {
          stop: async () => {
            order.push('commitRunner');
          },
        },
        container: {
          close: async () => {
            // 容器关闭过程中写下的 error 日志：这条必须在退出前落盘。
            logger.error('数据库连接已关闭。');
            order.push('container');
          },
        },
        logger,
      },
      'SIGTERM',
    );

    // flush 是最后一步：先停 HTTP、再停在途任务、再关容器、打最后一行，然后落盘。
    expect(order).toEqual(['server', 'commitRunner', 'container', 'exitLog', 'flush']);

    const lines = (await readFile(filePath, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ msg: '退出前的第一条' });
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ msg: '退出前的第二条' });
    // 容器关闭时写的 error 也在，且它在 flush 之前入队。
    expect(JSON.parse(lines[2] ?? '')).toMatchObject({ msg: '数据库连接已关闭。' });
  });
});
