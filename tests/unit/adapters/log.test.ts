import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConsoleLogger, FileLogger, NullLogger } from '../../../src/adapters/log/index.js';
import type { Logger } from '../../../src/domain/log.js';

const FIXED_NOW = new Date('2026-11-08T00:00:00.000Z');

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'comem-log-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface LineCollector {
  readonly lines: string[];
  readonly write: (line: string) => void;
}

function collector(): LineCollector {
  const lines: string[] = [];
  return {
    lines,
    write: (line: string) => {
      lines.push(line);
    },
  };
}

function createLogger(): Logger {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

/** 最后一行必须是合法 JSON；空输出时给一条能定位的消息。 */
function parseLast(lines: readonly string[]): Record<string, unknown> {
  const line = lines.at(-1);
  if (line === undefined) {
    throw new Error('没有日志输出');
  }
  return JSON.parse(line) as Record<string, unknown>;
}

describe('ConsoleLogger', () => {
  it('一行一个 JSON 对象，带 level / time / msg 与调用字段（§17.8）', () => {
    const sink = collector();
    const logger = new ConsoleLogger({
      level: 'info',
      write: sink.write,
      now: () => FIXED_NOW,
    });

    logger.info('服务启动', { port: 1933 });

    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]?.endsWith('\n')).toBe(true);
    expect(parseLast(sink.lines)).toEqual({
      port: 1933,
      level: 'info',
      time: FIXED_NOW.toISOString(),
      msg: '服务启动',
    });
  });

  it('bindings 出现在每一行，保留键不会被同名字段改写', () => {
    const sink = collector();
    const logger = new ConsoleLogger({
      level: 'debug',
      write: sink.write,
      now: () => FIXED_NOW,
      bindings: { service: 'comem' },
    });

    logger.debug('第一条');
    logger.error('第二条', { level: 'info', time: '伪造时间' });

    expect(parseLast(sink.lines)['service']).toBe('comem');
    expect(sink.lines).toHaveLength(2);
    const second = parseLast(sink.lines);
    expect(second['level']).toBe('error');
    expect(second['time']).toBe(FIXED_NOW.toISOString());
  });

  it('级别以下的调用不产生输出，也不做序列化（热路径）', () => {
    const sink = collector();
    const logger = new ConsoleLogger({ level: 'warn', write: sink.write, now: () => FIXED_NOW });
    const stringify = vi.spyOn(JSON, 'stringify');

    try {
      logger.debug('d');
      logger.info('i');
      expect(sink.lines).toHaveLength(0);
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }

    logger.warn('w');
    logger.error('e');
    expect(sink.lines).toHaveLength(2);
  });

  it('时间可注入', () => {
    const sink = collector();
    const later = new Date('2027-01-02T03:04:05.000Z');
    const logger = new ConsoleLogger({ level: 'info', write: sink.write, now: () => later });

    logger.info('x');

    expect(parseLast(sink.lines)['time']).toBe(later.toISOString());
  });

  it('默认写 process.stdout', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const logger = new ConsoleLogger({ level: 'info', now: () => FIXED_NOW });
      logger.info('到标准输出');
      expect(write).toHaveBeenCalledTimes(1);
      const line = write.mock.calls[0]?.[0];
      expect(typeof line).toBe('string');
      expect(String(line)).toContain('"msg":"到标准输出"');
    } finally {
      write.mockRestore();
    }
  });
});

describe('NullLogger', () => {
  it('丢弃一切日志', () => {
    // 按接口使用：`NullLogger` 的方法不声明参数（没有可用的东西），调用方一律看
    // `Logger` 接口，否则会以为它连参数都不收。
    const logger: Logger = new NullLogger();

    expect(() => {
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e', { requestId: 'req_1' });
    }).not.toThrow();
  });
});

describe('FileLogger', () => {
  it('只把 error 写进文件，其余照常转给 inner', async () => {
    const dir = await tempDir();
    const filePath = join(dir, 'logs', 'error.log');
    const inner = createLogger();
    const logger = new FileLogger({ inner, filePath });

    logger.info('不落盘');
    logger.error('落盘', { requestId: 'req_1' });
    await logger.flush();

    expect(inner.info).toHaveBeenCalledWith('不落盘', undefined);
    expect(inner.error).toHaveBeenCalledWith('落盘', { requestId: 'req_1' });

    const lines = (await readFile(filePath, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      level: 'error',
      msg: '落盘',
      requestId: 'req_1',
    });
  });

  it('超过 maxBytes 时轮转成 .1，只保留一份历史', async () => {
    const dir = await tempDir();
    const filePath = join(dir, 'error.log');
    const logger = new FileLogger({ inner: new NullLogger(), filePath, maxBytes: 1 });

    logger.error('first');
    await logger.flush();
    logger.error('second');
    await logger.flush();

    expect(existsSync(`${filePath}.1`)).toBe(true);
    expect(JSON.parse((await readFile(`${filePath}.1`, 'utf8')).trim())).toMatchObject({
      msg: 'first',
    });
    expect(JSON.parse((await readFile(filePath, 'utf8')).trim())).toMatchObject({ msg: 'second' });

    logger.error('third');
    await logger.flush();
    expect(JSON.parse((await readFile(`${filePath}.1`, 'utf8')).trim())).toMatchObject({
      msg: 'second',
    });
    expect(JSON.parse((await readFile(filePath, 'utf8')).trim())).toMatchObject({ msg: 'third' });
  });

  it('写入失败时降级为只输出，并且只 warn 一次', async () => {
    const dir = await tempDir();
    // 父路径是普通文件：mkdir 必然失败，模拟「error.log 所在目录建不出来」。
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'x');
    const filePath = join(blocker, 'error.log');
    const inner = createLogger();
    const logger = new FileLogger({ inner, filePath });

    logger.error('a');
    await logger.flush();
    logger.error('b');
    await logger.flush();

    expect(inner.error).toHaveBeenCalledTimes(2);
    expect(inner.warn).toHaveBeenCalledTimes(1);
    expect(inner.warn).toHaveBeenCalledWith(
      expect.stringContaining('失败'),
      expect.objectContaining({ filePath }),
    );
  });
});
