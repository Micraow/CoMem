import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, loadConfigSnapshot } from '../../src/config/index.js';
import { writeOverrideFile } from '../../src/config/override.js';
import { ComemError } from '../../src/domain/errors.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'comem-override-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function configPath(): string {
  return join(tempDir, 'config.yaml');
}

function overridePath(): string {
  return join(tempDir, '_meta', 'config.override.yaml');
}

function writeConfig(content: string): string {
  writeFileSync(configPath(), `dataDir: "${tempDir}"\n${content}`, 'utf8');
  return configPath();
}

function writeOverride(content: string): string {
  mkdirSync(join(tempDir, '_meta'), { recursive: true });
  writeFileSync(overridePath(), content, 'utf8');
  return overridePath();
}

function testEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { XDG_DATA_HOME: join(tempDir, 'xdg'), ...extra };
}

function loadError(options: Parameters<typeof loadConfig>[0]): ComemError {
  try {
    loadConfig(options);
  } catch (error) {
    expect(error).toBeInstanceOf(ComemError);
    return error as ComemError;
  }
  throw new Error('期望 loadConfig 抛错，但它返回了配置');
}

describe('覆盖文件：两阶段加载', () => {
  it('覆盖文件优先于 config.yaml', () => {
    writeConfig('providers:\n  llm:\n    default:\n      baseUrl: http://file.example/v1\n');
    writeOverride('providers:\n  llm:\n    default:\n      baseUrl: http://override.example/v1\n');

    const snapshot = loadConfigSnapshot({ path: configPath(), env: testEnv() });

    expect(snapshot.config.providers.llm.default.baseUrl).toBe('http://override.example/v1');
    expect(snapshot.sources.get('providers.llm.default.baseUrl')).toBe('override');
    expect(snapshot.overridePath).toBe(overridePath());
  });

  it('环境变量优先于覆盖文件', () => {
    writeConfig('providers:\n  llm:\n    default:\n      baseUrl: http://file.example/v1\n');
    writeOverride('providers:\n  llm:\n    default:\n      baseUrl: http://override.example/v1\n');

    const snapshot = loadConfigSnapshot({
      path: configPath(),
      env: testEnv({ COMEM_PROVIDERS_LLM_DEFAULT_BASE_URL: 'http://env.example/v1' }),
    });

    expect(snapshot.config.providers.llm.default.baseUrl).toBe('http://env.example/v1');
    expect(snapshot.sources.get('providers.llm.default.baseUrl')).toBe('env');
  });

  it('深合并：只覆盖写到的叶子，未写的保留文件值', () => {
    writeConfig(
      [
        'providers:',
        '  llm:',
        '    default:',
        '      model: file-model',
        '      pricing:',
        '        inputPerMillion: 1.5',
        '        outputPerMillion: 2.5',
      ].join('\n'),
    );
    writeOverride(
      ['providers:', '  llm:', '    default:', '      pricing:', '        outputPerMillion: 9.5'].join(
        '\n',
      ),
    );

    const config = loadConfig({ path: configPath(), env: testEnv() });

    expect(config.providers.llm.default.model).toBe('file-model');
    expect(config.providers.llm.default.pricing.inputPerMillion).toBe(1.5);
    expect(config.providers.llm.default.pricing.outputPerMillion).toBe(9.5);
  });

  it('空串覆盖会清除已有密钥', () => {
    writeConfig('providers:\n  llm:\n    default:\n      apiKey: sk-file\n');
    writeOverride('providers:\n  llm:\n    default:\n      apiKey: ""\n');

    expect(loadConfig({ path: configPath(), env: testEnv() }).providers.llm.default.apiKey).toBe('');
  });

  it('来源映射区分 default / file / override / env', () => {
    writeConfig(
      [
        'providers:',
        '  llm:',
        '    default:',
        '      baseUrl: http://file.example/v1',
        '      apiKey: sk-file',
      ].join('\n'),
    );
    writeOverride('providers:\n  llm:\n    default:\n      baseUrl: http://override.example/v1\n');

    const snapshot = loadConfigSnapshot({
      path: configPath(),
      env: testEnv({ COMEM_LOGGING_LEVEL: 'warn' }),
    });

    expect(snapshot.sources.get('providers.llm.default.baseUrl')).toBe('override');
    expect(snapshot.sources.get('providers.llm.default.apiKey')).toBe('file');
    expect(snapshot.sources.get('providers.llm.default.model')).toBe('default');
    expect(snapshot.sources.get('logging.level')).toBe('env');
    expect(snapshot.sources.get('dataDir')).toBe('file');
  });
});

describe('覆盖文件：启动期拒绝', () => {
  it('出现 dataDir 直接报错，并点名路径与字段', () => {
    writeConfig('');
    writeOverride('dataDir: /tmp/other\n');

    const error = loadError({ path: configPath(), env: testEnv() });

    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.message).toContain(overridePath());
    expect(error.message).toContain('dataDir');
    expect(error.message).toContain('换库');
    expect(error.details).toMatchObject({ path: overridePath(), field: 'dataDir' });
  });

  it('YAML 语法错误不会被当成空对象', () => {
    writeConfig('');
    writeOverride('server: [unclosed\n');

    const error = loadError({ path: configPath(), env: testEnv() });

    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.message).toContain(overridePath());
    expect(error.message).toContain('YAML');
  });

  it('未知键（拼写错误）启动失败', () => {
    writeConfig('');
    writeOverride('providers:\n  llm:\n    default:\n      baseURL: http://typo/v1\n');

    const error = loadError({ path: configPath(), env: testEnv() });

    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.message).toContain(overridePath());
    expect(error.message).toContain('providers.llm.default.baseURL');
  });

  it('值类型不符时报覆盖文件路径与字段', () => {
    writeConfig('');
    writeOverride('providers:\n  llm:\n    default:\n      maxTokens: lots\n');

    const error = loadError({ path: configPath(), env: testEnv() });

    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.message).toContain(overridePath());
    expect(error.message).toContain('providers.llm.default.maxTokens');
    expect(error.details).toMatchObject({
      path: overridePath(),
      fields: ['providers.llm.default.maxTokens'],
    });
  });
});

describe('writeOverrideFile', () => {
  it('成功时写入 0600 的 YAML', async () => {
    await writeOverrideFile(overridePath(), {
      providers: { llm: { default: { apiKey: 'sk-secret' } } },
    });

    const mode = statSync(overridePath()).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readFileSync(overridePath(), 'utf8')).toContain('sk-secret');
  });

  it('父路径不是目录时明确失败，且不留临时文件', async () => {
    const blocked = join(tempDir, 'blocked');
    writeFileSync(blocked, 'not a directory', 'utf8');

    await expect(
      writeOverrideFile(join(blocked, 'config.override.yaml'), { server: { port: 1 } }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });

    expect(statSync(blocked).isFile()).toBe(true);
    expect(readdirSync(tempDir).filter((name) => name.includes('.tmp'))).toEqual([]);
  });
});
