/**
 * 配置解析（架构文档 §8.9、§18）。
 *
 * 扁平 YAML 子集的边界要钉住：支持什么、跳过什么、什么算错误。静默吞掉一个拼错
 * 的配置，比直接报错更难查。
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  DEFAULT_QUERY_FILTERS,
  isBypassed,
  loadConfig,
  parseFlatYaml,
  resolveHost,
} from '../lib/config.mjs';
import { ComemHookError } from '../lib/http.mjs';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'comem-config-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('标量：字符串 / 引号 / 数字 / 布尔 / null', () => {
  const parsed = parseFlatYaml(
    [
      'baseUrl: http://127.0.0.1:1933',
      "quoted: 'a: b'",
      'double: "x # y"',
      'count: 42',
      'ratio: 0.5',
      'enabled: true',
      'disabled: false',
      'empty: null',
    ].join('\n'),
  );
  assert.deepEqual(parsed, {
    baseUrl: 'http://127.0.0.1:1933',
    quoted: 'a: b',
    double: 'x # y',
    count: 42,
    ratio: 0.5,
    enabled: true,
    disabled: false,
    empty: null,
  });
});

test('顶层序列与空序列', () => {
  const parsed = parseFlatYaml(
    ['queryFilters:', "  - 's|a|b|'", "  - 's|c|d|g'", 'other: []'].join('\n'),
  );
  assert.deepEqual(parsed, { queryFilters: ['s|a|b|', 's|c|d|g'], other: [] });
});

test('整行注释被忽略', () => {
  assert.deepEqual(parseFlatYaml('# 说明\nkey: value\n'), { key: 'value' });
});

test('嵌套段整段跳过（服务端配置里的 server: / retrieval:）', () => {
  const parsed = parseFlatYaml(
    ['server:', '  host: 127.0.0.1', '  port: 1933', 'retrieval:', '  queryFilters: []', 'userId: alice'].join(
      '\n',
    ),
  );
  assert.deepEqual(parsed, { userId: 'alice' });
});

test('不是 key: value 的行报错，并带行号', () => {
  assert.throws(
    () => parseFlatYaml('good: 1\nthis is not yaml'),
    (error) => {
      assert.ok(error instanceof ComemHookError);
      assert.equal(error.code, 'HOOK_INVALID_CONFIG');
      assert.match(error.message, /第 2 行/);
      return true;
    },
  );
});

test('没有键的序列报错', () => {
  assert.throws(() => parseFlatYaml('  - orphan'), /没有对应的键/);
});

test('文件不存在时全部走默认值', async () => {
  await withTempDir(async (dir) => {
    const config = await loadConfig({ env: { COMEM_CONFIG_FILE: join(dir, 'missing.yaml') } });
    assert.equal(config.baseUrl, 'http://127.0.0.1:1933');
    assert.equal(config.timeoutMs, 5000);
    assert.deepEqual(config.queryFilters, DEFAULT_QUERY_FILTERS);
    assert.equal(config.tmpDir, tmpdir());
  });
});

test('文件覆盖默认值，环境变量覆盖文件', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'config.yaml');
    await writeFile(
      file,
      ['baseUrl: http://file:1111', 'userId: from-file', 'queryFilters:', "  - 's|a|b|'"].join('\n'),
      'utf8',
    );

    const config = await loadConfig({
      env: {
        COMEM_CONFIG_FILE: file,
        COMEM_BASE_URL: 'http://env:2222',
        COMEM_TIMEOUT_MS: '1000',
        COMEM_HOOK_TMPDIR: join(dir, 'tmp'),
      },
    });
    assert.equal(config.baseUrl, 'http://env:2222');
    assert.equal(config.userId, 'from-file');
    assert.equal(config.timeoutMs, 1000);
    assert.deepEqual(config.queryFilters, ['s|a|b|']);
    assert.equal(config.tmpDir, join(dir, 'tmp'));
  });
});

test('环境变量里的规则用换行分隔', async () => {
  await withTempDir(async (dir) => {
    const config = await loadConfig({
      env: {
        COMEM_CONFIG_FILE: join(dir, 'missing.yaml'),
        COMEM_QUERY_FILTERS: 's|a|b|\ns|c|d|g',
      },
    });
    assert.deepEqual(config.queryFilters, ['s|a|b|', 's|c|d|g']);
  });
});

test('数字配置项不是数字时报错', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'config.yaml');
    await writeFile(file, 'timeoutMs: 不是数字\n', 'utf8');
    await assert.rejects(() => loadConfig({ env: { COMEM_CONFIG_FILE: file } }), /timeoutMs/);
  });
});

test('bypass：整个会话', () => {
  assert.equal(isBypassed({ cwd: '/repo' }, { COMEM_BYPASS_SESSION: '1' }), true);
  assert.equal(isBypassed({ cwd: '/repo' }, { COMEM_BYPASS_SESSION: 'true' }), true);
  assert.equal(isBypassed({ cwd: '/repo' }, { COMEM_BYPASS_SESSION: '0' }), false);
  assert.equal(isBypassed({ cwd: '/repo' }, {}), false);
});

test('bypass：按路径 glob 关掉（§8.9 的示例必须能命中）', () => {
  const env = { COMEM_BYPASS_SESSION_PATTERNS: '*/scratch/*,*/tmp/*' };
  assert.equal(isBypassed({ cwd: '/home/alice/scratch/exp' }, env), true);
  assert.equal(isBypassed({ cwd: '/tmp/work' }, env), true);
  assert.equal(isBypassed({ cwd: '/home/alice/repo' }, env), false);
  // 多个模式是「任一命中」。
  assert.equal(isBypassed({ cwd: '/home/alice/repo' }, { COMEM_BYPASS_SESSION_PATTERNS: '*/nope/*' }), false);
});

test('bypass：path 优先于 cwd', () => {
  const env = { COMEM_BYPASS_SESSION_PATTERNS: '*/scratch/*' };
  assert.equal(isBypassed({ cwd: '/home/alice/repo', path: '/home/alice/scratch/a.ts' }, env), true);
});

test('宿主解析：claude-code 与 dsh 都能加载', async () => {
  const claude = await resolveHost({ env: {}, argv: [] });
  assert.equal(claude.SESSION_ID_PREFIX, 'cc-');
  const dsh = await resolveHost({ env: {}, argv: [] }).then(() =>
    resolveHost({ env: {}, argv: ['--host', 'dsh'] }),
  );
  assert.equal(dsh.SESSION_ID_PREFIX, 'dsh-');
});

test('宿主名不合法（路径穿越）时拒绝加载', async () => {
  await assert.rejects(
    () => resolveHost({ env: {}, argv: ['--host', '../../etc/passwd'] }),
    /宿主名不合法/,
  );
});

test('未知宿主给出安装提示', async () => {
  await assert.rejects(
    () => resolveHost({ env: {}, argv: ['--host', 'no-such-host'] }),
    /co-mem install --host no-such-host/,
  );
});
