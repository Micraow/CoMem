/**
 * 单用户模式的监听地址守卫（架构文档 §12.7、§18）。
 *
 * `auth.enabled: false` 时没有身份可言：任何能连上端口的人都是 `server.subject`。
 * 监听非回环地址必须是部署者显式选择的结果（打开认证），不能靠默认值碰巧安全。
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/index.js';
import { ComemError } from '../../src/domain/errors.js';

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

describe('auth.enabled: false 只允许回环监听', () => {
  it.each(['0.0.0.0', '::', '192.168.1.10', '10.0.0.1'])(
    'server.host = %s 启动失败，消息说明原因并给出最小配置',
    (host) => {
      const message = messageOf({ COMEM_SERVER_HOST: host });

      expect(message).toContain('auth.enabled');
      expect(message).toContain('server.host');
      expect(message).toContain('enabled: true');
      expect(message).toContain(host);
    },
  );

  it.each(['127.0.0.1', '127.1.2.3', 'localhost', '::1'])(
    'server.host = %s 是回环地址，放行',
    (host) => {
      expect(load({ COMEM_SERVER_HOST: host }).server.host).toBe(host);
    },
  );

  it('打开 auth.enabled 后允许监听 0.0.0.0（多用户部署）', () => {
    const config = load({ COMEM_SERVER_HOST: '0.0.0.0', COMEM_AUTH_ENABLED: 'true' });

    expect(config.server.host).toBe('0.0.0.0');
    expect(config.auth.enabled).toBe(true);
  });
});
