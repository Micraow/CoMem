/**
 * 设置页的纯逻辑（`web/utils/settings.ts`）。
 *
 * 仓库没有组件测试运行器（vitest 的 environment 是 `node`），所以这里分两层验证：
 *
 * 1. **纯函数**：分组、中文标签、来源徽章、密钥显示、`PATCH` 请求体、连接测试摘要。
 * 2. **接线**：页面源码里必须出现对应的调用点（`valueDisplayOf` / `disabled` /
 *    `aria-describedby` 等）。`web/pages/connect.vue` 的测试用同一套写法——把
 *    「函数对了但页面没接」变成可失败的断言，而不是靠人眼。
 *
 * 84 个叶子直接拿 `configSchema` 的默认值对拍：新增配置项时本文件会失败，不会让
 * 页面用裸路径顶上去。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { describeConfig } from '../../../src/config/metadata.js';
import { configSchema } from '../../../src/config/schema.js';
import type { ConfigSnapshot } from '../../../src/config/index.js';
import {
  CONFIG_GROUPS,
  CONFIG_SOURCES,
  CONFIG_TEST_TARGETS,
  INITIALLY_EXPANDED_GROUPS,
  RESTART_COMMANDS,
  SETTING_FIELDS,
  TEST_SCOPE_NOTE,
  buildPatchValues,
  draftOf,
  errorHintOf,
  fieldControlOf,
  fieldHintOf,
  fieldLabelOf,
  fieldOptionsOf,
  fieldPathOfError,
  groupSettings,
  isExpandedByDefault,
  restartNoticeOf,
  sourceLabelOf,
  sourceNoteOf,
  sourceToneOf,
  testSummaryOf,
  valueDisplayOf,
  type ConfigItemView,
  type ConfigTestPayload,
} from '../../../web/utils/settings.js';

const SETTINGS_PAGE = readFileSync(
  new URL('../../../web/pages/settings.vue', import.meta.url),
  'utf8',
);

const config = configSchema.parse({});
const snapshot: ConfigSnapshot = {
  config,
  configPath: '/tmp/comem/config.yaml',
  overridePath: '/var/lib/comem/_meta/config.override.yaml',
  sources: new Map(),
  defaults: config,
  fileConfig: {},
  overrideConfig: {},
  envOverrides: {},
  env: {},
};
const view = describeConfig(snapshot, true);

function itemOf(path: string, overrides: Partial<ConfigItemView> = {}): ConfigItemView {
  const base = view.items.find((item) => item.path === path);
  if (base === undefined) {
    throw new Error(`缺少配置项 ${path}`);
  }
  return { ...base, ...overrides };
}

describe('配置项清单', () => {
  it('84 个叶子都有中文标签与控件，标签位不出现裸路径', () => {
    expect(view.items).toHaveLength(84);
    expect(Object.keys(SETTING_FIELDS)).toHaveLength(84);

    const controls = new Set(['text', 'number', 'boolean', 'select', 'secret', 'list']);
    for (const item of view.items) {
      expect(Object.hasOwn(SETTING_FIELDS, item.path)).toBe(true);
      const label = fieldLabelOf(item.path);
      expect(label).not.toBe(item.path);
      expect(label).toMatch(/[\u4e00-\u9fff]/u);
      expect(controls.has(fieldControlOf(item.path))).toBe(true);
    }
  });

  it('路径只作为小字显示，控件用 label 的 for 关联', () => {
    expect(SETTINGS_PAGE).toContain('fieldLabelOf(item.path)');
    expect(SETTINGS_PAGE).toContain('{{ item.path }}');
    expect(SETTINGS_PAGE).toContain(':for="inputIdOf(item.path)"');
    expect(SETTINGS_PAGE).toContain(':id="inputIdOf(item.path)"');
  });
});

describe('分组', () => {
  const groups = groupSettings(view.items);

  it('按架构文档的分组顺序排列，中文标题固定', () => {
    expect(groups.map((group) => group.group)).toEqual([...CONFIG_GROUPS]);
    expect(groups.map((group) => group.label)).toEqual([
      '模型',
      '向量',
      '重排',
      '检索',
      '记忆',
      '会话',
      '任务',
      '遥测',
      '服务',
      '认证',
      '对话导入',
      '日志',
      '摘要',
      '权限',
    ]);
    expect(groups.flatMap((group) => group.items)).toHaveLength(84);
  });

  it('模型 / 向量 / 重排三组的中文名与路径一一对应', () => {
    const expected = {
      llm: {
        'providers.llm.default.type': '类型',
        'providers.llm.default.baseUrl': '网关地址',
        'providers.llm.default.model': '模型名',
        'providers.llm.default.apiKey': 'API 密钥',
        'providers.llm.default.maxTokens': '单次最大 token 数',
        'providers.llm.default.timeoutSeconds': '超时（秒）',
        'providers.llm.default.pricing.inputPerMillion': '输入价格（每百万 token）',
        'providers.llm.default.pricing.outputPerMillion': '输出价格（每百万 token）',
      },
      embedding: {
        'providers.embedding.type': '类型',
        'providers.embedding.baseUrl': '网关地址',
        'providers.embedding.model': '模型名',
        'providers.embedding.apiKey': 'API 密钥',
        'providers.embedding.dimension': '向量维度',
        'providers.embedding.maxBatchSize': '单次请求条数上限',
        'providers.embedding.timeoutSeconds': '超时（秒）',
        'providers.embedding.cache.enabled': '启用嵌入缓存',
        'providers.embedding.cache.maxEntries': '缓存最多保留条数',
      },
      rerank: {
        'providers.rerank.type': '类型',
        'providers.rerank.baseUrl': '网关地址',
        'providers.rerank.model': '模型名',
        'providers.rerank.apiKey': 'API 密钥',
        'providers.rerank.timeoutSeconds': '超时（秒）',
        'providers.rerank.topN': '候选条数上限',
      },
    } as const;

    for (const [group, fields] of Object.entries(expected)) {
      const actual = groups.find((candidate) => candidate.group === group);
      expect(actual).toBeDefined();
      expect(Object.fromEntries((actual?.items ?? []).map((item) => [item.path, fieldLabelOf(item.path)])))
        .toEqual(fields);
    }
  });

  it('向量的类型下拉写清本地与远程的区别', () => {
    const options = fieldOptionsOf('providers.embedding.type');
    expect(options.map((option) => option.value)).toEqual([
      'openai-compatible',
      'anthropic',
      'disabled',
    ]);
    expect(options[0]?.label).toContain('本地推理服务');
    expect(options[0]?.label).toContain('远程');
    expect(options[2]?.label).toContain('停用');
    expect(fieldHintOf('providers.embedding.type')).toContain('127.0.0.1:8089');
    expect(fieldHintOf('providers.embedding.baseUrl')).toContain('127.0.0.1:8089');
  });

  it('首屏只展开模型 / 向量 / 重排，其余折叠', () => {
    expect([...INITIALLY_EXPANDED_GROUPS]).toEqual(['llm', 'embedding', 'rerank']);
    expect(groups.filter((group) => isExpandedByDefault(group.group)).map((group) => group.group))
      .toEqual(['llm', 'embedding', 'rerank']);
    expect(SETTINGS_PAGE).toContain('v-if="expanded.has(group.group)"');
    expect(SETTINGS_PAGE).toContain(':aria-expanded="expanded.has(group.group)"');
  });

  it('只有三组模型供应商有连接测试入口', () => {
    expect(groups.filter((group) => group.testTarget !== null).map((group) => group.group))
      .toEqual([...CONFIG_TEST_TARGETS]);
    expect(groups.find((group) => group.group === 'memory')?.testTarget).toBeNull();
  });
});

describe('来源徽章', () => {
  it('四种来源各有一条文案，配色互不相同', () => {
    expect(CONFIG_SOURCES.map(sourceLabelOf)).toEqual([
      '默认值',
      '配置文件',
      '覆盖文件',
      '环境变量',
    ]);
    expect(new Set(CONFIG_SOURCES.map(sourceToneOf)).size).toBe(4);
    expect(sourceNoteOf('env')).toContain('环境变量优先');
  });

  it('页面按 item.source 渲染徽章', () => {
    expect(SETTINGS_PAGE).toContain('sourceLabelOf(item.source)');
    expect(SETTINGS_PAGE).toContain('sourceToneOf(item.source)');
    expect(SETTINGS_PAGE).toContain('sourceNoteOf(item.source)');
  });
});

describe('密钥显示', () => {
  it('已设置显示末 4 位掩码，未设置显示「未设置」', () => {
    expect(
      valueDisplayOf(
        itemOf('providers.llm.default.apiKey', {
          value: null,
          secret: true,
          configured: true,
          masked: '****1234',
        }),
      ),
    ).toBe('已设置 ····1234');

    expect(
      valueDisplayOf(
        itemOf('providers.llm.default.apiKey', {
          value: null,
          secret: true,
          configured: false,
          masked: null,
        }),
      ),
    ).toBe('未设置');
  });

  it('即使响应里误带明文，也不出现在显示文案里', () => {
    const plaintext = 'sk-live-abcdef1234';
    const display = valueDisplayOf(
      itemOf('providers.llm.default.apiKey', {
        value: plaintext,
        secret: true,
        configured: true,
        masked: '****1234',
      }),
    );

    expect(display).not.toContain(plaintext);
    expect(display).not.toContain('sk-live');
    expect(display).toBe('已设置 ····1234');
    expect(SETTINGS_PAGE).toContain("fieldControlOf(item.path) === 'secret'");
    expect(SETTINGS_PAGE).toContain('type="password"');
  });

  it('非密钥项显示真实值，空值有明确文案', () => {
    expect(valueDisplayOf(itemOf('providers.llm.default.baseUrl'))).toBe(
      'https://api.example.com/v1',
    );
    expect(valueDisplayOf(itemOf('retrieval.rerank.enabled'))).toBe('关闭');
    expect(valueDisplayOf(itemOf('providers.llm.default.apiKey'))).toBe('未设置');
    expect(valueDisplayOf(itemOf('dataDir'))).toBe('—');
  });
});

describe('不可编辑项', () => {
  it('仍渲染，显示原因并禁用控件', () => {
    const locked = itemOf('task.leaseSeconds');
    expect(locked.editable).toBe(false);
    expect(locked.reason).toBeTruthy();
    expect(valueDisplayOf(locked)).toBe('—');

    expect(SETTINGS_PAGE).toContain(':disabled="!item.editable"');
    expect(SETTINGS_PAGE).toContain('item.reason !== undefined');
    expect(SETTINGS_PAGE).toContain('{{ item.reason }}');
  });

  it('不可编辑项不会被分组过滤掉', () => {
    const rendered = groupSettings(view.items).flatMap((group) => group.items);
    expect(rendered).toHaveLength(view.items.length);
    expect(rendered.some((item) => !item.editable)).toBe(true);
  });
});

describe('保存', () => {
  const drafts = Object.fromEntries(view.items.map((item) => [item.path, draftOf(item)]));

  it('没改动就不写覆盖文件', () => {
    expect(buildPatchValues(view.items, drafts)).toEqual({ values: {}, errors: {} });
  });

  it('只提交改动过的可编辑项，按字段类型转换', () => {
    const patch = buildPatchValues(view.items, {
      ...drafts,
      'providers.llm.default.baseUrl': 'http://127.0.0.1:8089/v1',
      'providers.llm.default.apiKey': 'sk-test',
      'retrieval.rerank.enabled': 'true',
      'memory.reviewRequired': 'rules\npreferences',
      'providers.llm.default.maxTokens': '2048',
      // 不可编辑项即使被改也不提交。
      'task.leaseSeconds': '99',
    });

    expect(patch.errors).toEqual({});
    expect(patch.values).toEqual({
      'providers.llm.default.baseUrl': 'http://127.0.0.1:8089/v1',
      'providers.llm.default.apiKey': 'sk-test',
      'retrieval.rerank.enabled': true,
      'memory.reviewRequired': ['rules', 'preferences'],
      'providers.llm.default.maxTokens': 2048,
    });
  });

  it('密钥留空 = 不改；点「清除」才写空串', () => {
    expect(buildPatchValues(view.items, drafts).values).toEqual({});
    expect(
      buildPatchValues(view.items, drafts, new Set(['providers.llm.default.apiKey'])),
    ).toEqual({ values: { 'providers.llm.default.apiKey': '' }, errors: {} });
  });

  it('数字不合法时把错误留在字段上，不提交', () => {
    const patch = buildPatchValues(view.items, {
      ...drafts,
      'providers.llm.default.maxTokens': '很多',
    });

    expect(patch.values).toEqual({});
    expect(patch.errors).toEqual({ 'providers.llm.default.maxTokens': '请填写有效的数字。' });
  });

  it('保存成功后的提示条说明写到哪个文件、必须重启', () => {
    const notice = restartNoticeOf('/var/lib/comem/_meta/config.override.yaml');

    expect(notice).toContain('设置已保存到 /var/lib/comem/_meta/config.override.yaml');
    expect(notice).toContain('需要重启 CoMem 才能生效');
    expect(notice).toContain('配置只在启动时读一次');
    expect(notice).not.toContain('已应用');
    expect(RESTART_COMMANDS.map((command) => command.command)).toEqual([
      'pnpm dev',
      'docker compose restart comem',
    ]);

    expect(SETTINGS_PAGE).toContain("api.patch<");
    expect(SETTINGS_PAGE).toContain('restartNoticeOf(saveResult.overridePath)');
    expect(SETTINGS_PAGE).toContain('DomainCodeBlock');
  });
});

describe('保存失败', () => {
  const paths = view.items.map((item) => item.path);

  it('环境变量遮住某项时，按 details.field 挂到对应字段', () => {
    const message =
      '配置项 providers.llm.default.baseUrl 由环境变量 COMEM_PROVIDERS_LLM_DEFAULT_BASE_URL 覆盖，写覆盖文件不会生效。';
    expect(fieldPathOfError(message, { field: 'providers.llm.default.baseUrl' }, paths)).toBe(
      'providers.llm.default.baseUrl',
    );
    // 没有 details 时退回消息里找路径。
    expect(fieldPathOfError(message, undefined, paths)).toBe('providers.llm.default.baseUrl');
    expect(fieldPathOfError('values 不能为空。', undefined, paths)).toBeNull();
    expect(errorHintOf(message)).toContain('环境变量优先于本页设置');
    expect(errorHintOf('请填写有效的数字。')).toBeNull();
    expect(errorHintOf(null)).toBeNull();
  });

  it('错误原文显示在字段旁（role=alert）', () => {
    expect(SETTINGS_PAGE).toContain('settings-row__error');
    expect(SETTINGS_PAGE).toContain('role="alert"');
    expect(SETTINGS_PAGE).toContain('displayErrorOf(item)');
    expect(SETTINGS_PAGE).toContain('fieldPathOfError(');
  });
});

describe('测试连接', () => {
  const success: ConfigTestPayload = {
    ok: true,
    latencyMs: 42,
    detail: '模型 gpt-4o-mini 可用。',
  };
  const failure: ConfigTestPayload = {
    ok: false,
    latencyMs: 12,
    detail: '模型调用失败（PROVIDER_UNAVAILABLE）：401 Unauthorized',
  };

  it('成功与失败都显示 ok / 耗时，detail 原样保留', () => {
    expect(testSummaryOf(success)).toBe('通过 · 42 ms');
    expect(testSummaryOf(failure)).toBe('失败 · 12 ms');
    expect(failure.detail).toContain('401 Unauthorized');
    expect(SETTINGS_PAGE).toContain('probeOkOf(group.testTarget)');
    expect(SETTINGS_PAGE).toContain('probeDetailOf(group.testTarget)');
  });

  it('固定说明文案存在，且请求打到 /config/test', () => {
    expect(TEST_SCOPE_NOTE).toBe(
      '「测试连接」测的是当前正在运行的配置，不是刚保存、还没重启的配置。',
    );
    expect(SETTINGS_PAGE).toContain('{{ TEST_SCOPE_NOTE }}');
    expect(SETTINGS_PAGE).toContain("'/config/test'");
    expect(SETTINGS_PAGE).toContain('target');
  });
});
