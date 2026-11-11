/**
 * 回环信任的监听地址守卫（架构文档 §12.7、§18）。
 *
 * `auth.trustLoopback` 打开时，没有凭据的回环请求被认证成 `server.subject`。
 * 监听非回环地址（`0.0.0.0` / `::` / 本机网卡地址）意味着任何能连上端口的人都能
 * 成为这个用户，所以这种组合必须在启动期失败，不能配了不生效。
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/index.js';
import { ComemError } from '../../src/domain/errors.js';
import { isLoopbackHostHeader } from '../../src/domain/network.js';

/** 不存在的配置文件：只走默认值 + 环境变量覆盖。 */
const MISSING_CONFIG = join(process.cwd(), 'local', 'tmp', 'missing-config.yaml');

function load(env: Record<string, string>): ReturnType<typeof loadConfig> {
  return loadConfig({
    path: MISSING_CONFIG,
    env,
    argv: [],
    container: false,
    isRoot: false,
  });
}

function messageOf(env: Record<string, string>): string {
  try {
    load(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ComemError);
    return (error as ComemError).message;
  }
  throw new Error('期望 loadConfig 抛错，实际通过了。');
}

describe('回环信任只允许回环监听', () => {
  it('默认打开，且默认监听地址是回环', () => {
    const config = load({});

    expect(config.auth.trustLoopback).toBe(true);
    expect(config.server.host).toBe('127.0.0.1');
  });

  it.each(['0.0.0.0', '::', '192.168.1.10', '10.0.0.1'])(
    'server.host = %s 启动失败，消息说明原因并给出最小配置',
    (host) => {
      const message = messageOf({ COMEM_SERVER_HOST: host });

      expect(message).toContain('auth.trustLoopback');
      expect(message).toContain('server.host');
      expect(message).toContain('trustLoopback: false');
      expect(message).toContain(host);
    },
  );

  it.each(['127.0.0.1', '127.1.2.3', 'localhost', '::1'])(
    'server.host = %s 是回环地址，放行',
    (host) => {
      expect(load({ COMEM_SERVER_HOST: host }).server.host).toBe(host);
    },
  );

  it('关掉回环信任后允许监听 0.0.0.0（容器 / 反向代理部署）', () => {
    const config = load({
      COMEM_SERVER_HOST: '0.0.0.0',
      COMEM_AUTH_TRUST_LOOPBACK: 'false',
    });

    expect(config.server.host).toBe('0.0.0.0');
    expect(config.auth.trustLoopback).toBe(false);
  });
});

describe('Host 头判定（DNS rebinding 防线）', () => {
  it.each(['127.0.0.1', '127.0.0.1:1933', 'localhost', 'localhost:80', '[::1]', '[::1]:1933'])(
    '%s 指向本机',
    (host) => {
      expect(isLoopbackHostHeader(host)).toBe(true);
    },
  );

  it.each([undefined, '', 'comem.example.com', 'comem.example.com:1933', '10.0.0.1:1933', '[]'])(
    '%s 不指向本机',
    (host) => {
      expect(isLoopbackHostHeader(host)).toBe(false);
    },
  );
});
