/**
 * 设置页（`/settings`）的纯逻辑：分组、中文标签、来源徽章与请求体拼装。
 *
 * ## 为什么标签表在控制台里
 *
 * `GET /api/v1/config` 只回路径（`providers.llm.default.baseUrl`）、值与来源，
 * 不回中文名——服务端的字段名是配置契约的一部分，界面文案不是。所以「路径 → 中文名
 * /控件 / 选项」这张表在 web 侧，`tests/unit/web/settings.test.ts` 直接拿
 * `configSchema` 的 84 个叶子对拍：少一条或多一条都会失败。没有这张对拍表，新增
 * 配置项会以裸路径出现在页面上，看起来像「这是个没做完的页面」。
 *
 * ## 值只有两种来源
 *
 * - 密钥类（`apiKey` / `auth.sessionSecret`）：服务端只回 `configured` 与掩码
 *   （`****1234`），明文永远不在响应里。界面显示「已设置 ····1234」或「未设置」，
 *   **不读 `value`**——即使服务端以后错误地把明文放进来，这里也不会渲染它。
 * - 其它项：`value` 原样显示。不可暴露项的 `value` 是 `null`，显示「—」并附
 *   `reason`。
 *
 * ## 保存与生效是两件事
 *
 * 服务端配置只在启动时读一次，`PATCH` 成功只代表写进了覆盖文件。响应里的
 * `restartRequired` 恒为 `true`，页面的提示条与 `RESTART_COMMANDS` 说的都是
 * 「重启后生效」，不写「已应用」。
 */

import { isRecord } from './record'

/** `GET /config` 的 `source` 取值（`src/config/index.ts` 的 `ConfigSource`）。 */
export const CONFIG_SOURCES = ['default', 'file', 'override', 'env'] as const

export type ConfigSource = (typeof CONFIG_SOURCES)[number]

/** `GET /config` 的 `group` 取值（`src/config/metadata.ts` 的 `ConfigGroup`）。 */
export const CONFIG_GROUPS = [
  'llm',
  'embedding',
  'rerank',
  'retrieval',
  'memory',
  'session',
  'task',
  'telemetry',
  'server',
  'auth',
  'ingest',
  'logging',
  'summary',
  'acl',
] as const

export type ConfigGroup = (typeof CONFIG_GROUPS)[number]

/** 一个配置叶子（`src/config/metadata.ts` 的 `ConfigLeafView`）。 */
export interface ConfigItemView {
  readonly path: string
  /** 密钥类与不可暴露项为 `null`。 */
  readonly value: unknown
  readonly source: ConfigSource
  readonly secret: boolean
  /** 仅密钥类有意义：值非空即已设置。 */
  readonly configured: boolean
  /** 仅密钥类：`****abcd`（末 4 位）；未设置为 `null`。 */
  readonly masked: string | null
  readonly envName: string
  readonly editable: boolean
  readonly group: ConfigGroup
  /** 不可写 / 不可暴露的原因。 */
  readonly reason?: string
}

/** `GET /config` 的响应体。 */
export interface ConfigViewPayload {
  readonly overridePath: string
  readonly overrideWritable: boolean
  readonly items: readonly ConfigItemView[]
}

/** `PATCH /config` 的响应体。`restartRequired` 恒为 `true`。 */
export interface ConfigPatchPayload {
  readonly written: number
  readonly overridePath: string
  readonly restartRequired: true
}

/** 连接测试能测的三组（`POST /config/test` 的 `target`）。 */
export const CONFIG_TEST_TARGETS = ['llm', 'embedding', 'rerank'] as const

export type ConfigTestTarget = (typeof CONFIG_TEST_TARGETS)[number]

/** `POST /config/test` 的响应体。`detail` 是失败原文，界面不翻译。 */
export interface ConfigTestPayload {
  readonly ok: boolean
  readonly latencyMs: number
  readonly detail: string
}

/** 分组标题。`memory` 等分组默认折叠，标题是唯一可见的那一行。 */
const GROUP_LABELS = {
  llm: '模型',
  embedding: '向量',
  rerank: '重排',
  retrieval: '检索',
  memory: '记忆',
  session: '会话',
  task: '任务',
  telemetry: '遥测',
  server: '服务',
  auth: '认证',
  ingest: '对话导入',
  logging: '日志',
  summary: '摘要',
  acl: '权限',
} satisfies Record<ConfigGroup, string>

/** 来源 → 徽章文案。四种来源是本页最有价值的一列：它回答「为什么我改了不生效」。 */
const SOURCE_LABELS = {
  default: '默认值',
  file: '配置文件',
  override: '覆盖文件',
  env: '环境变量',
} satisfies Record<ConfigSource, string>

/** 来源 → 徽章配色。语义与文字同时表达，颜色不单独表意。 */
const SOURCE_TONES = {
  default: 'gray',
  file: 'blue',
  override: 'teal',
  env: 'orange',
} as const satisfies Record<ConfigSource, 'gray' | 'blue' | 'teal' | 'orange'>

/** 来源造成的优先级说明：环境变量永远压过页面写入的覆盖文件。 */
const SOURCE_NOTES = {
  default: '没有任何配置文件与环境变量设置它。',
  file: '来自 config.yaml。保存后写入覆盖文件，覆盖它。',
  override: '来自覆盖文件（本页写入的那份）。',
  env: '环境变量优先于本页设置；要改它得改环境变量再重启。',
} satisfies Record<ConfigSource, string>

/** 控件种类。值都按字符串编辑，保存时再转成配置类型。 */
export type SettingControl = 'text' | 'number' | 'boolean' | 'select' | 'secret' | 'list'

export interface SettingOption {
  readonly value: string
  readonly label: string
}

export interface SettingField {
  /** 中文名。路径另起一行小字显示，不占标签位。 */
  readonly label: string
  readonly control: SettingControl
  /** `select` 的选项；其它控件没有。 */
  readonly options?: readonly SettingOption[]
  /** 字段下方的说明。只写「填什么值」，不写内部实现。 */
  readonly hint?: string
}

const LLM_TYPE_OPTIONS: readonly SettingOption[] = [
  { value: 'openai-compatible', label: 'OpenAI 兼容' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'disabled', label: '停用（不调用模型）' },
]

const EMBEDDING_TYPE_OPTIONS: readonly SettingOption[] = [
  { value: 'openai-compatible', label: 'OpenAI 兼容（本地推理服务 / 远程网关）' },
  { value: 'anthropic', label: 'Anthropic（不提供嵌入接口，启动会失败）' },
  { value: 'disabled', label: '停用（不产生嵌入调用）' },
]

const RERANK_TYPE_OPTIONS: readonly SettingOption[] = [
  { value: 'http', label: 'HTTP 重排服务' },
  { value: 'disabled', label: '停用（不产生重排调用）' },
]

const RETRIEVAL_ENGINE_OPTIONS: readonly SettingOption[] = [
  { value: 'fts5', label: '关键词（FTS5）' },
  { value: 'vector', label: '语义（向量）' },
  { value: 'hybrid', label: '混合（RRF 融合）' },
]

const QUOTA_PRESET_OPTIONS: readonly SettingOption[] = [
  { value: 'chat', label: '聊天' },
  { value: 'coding', label: '编程' },
]

const EXPIRY_ACTION_OPTIONS: readonly SettingOption[] = [
  { value: 'archive', label: '归档（可恢复）' },
  { value: 'delete', label: '删除（不可逆）' },
]

const SUMMARY_GENERATOR_OPTIONS: readonly SettingOption[] = [
  { value: 'llm', label: '模型生成' },
  { value: 'rule', label: '规则生成' },
]

const ACL_LEVEL_OPTIONS: readonly SettingOption[] = [
  { value: 'write', label: '可写' },
  { value: 'read', label: '只读' },
]

const LOG_LEVEL_OPTIONS: readonly SettingOption[] = [
  { value: 'debug', label: '调试' },
  { value: 'info', label: '信息' },
  { value: 'warn', label: '警告' },
  { value: 'error', label: '错误' },
  { value: 'fatal', label: '致命' },
]

/**
 * 84 个配置叶子的中文名、控件与选项。
 *
 * 键是 `GET /config` 的 `path`，与 `src/config/schema.ts` 的默认值形状一一对应。
 * 新增配置项时这里必须补一条——`tests/unit/web/settings.test.ts` 会拿
 * `configSchema` 的叶子逐条比对。
 */
export const SETTING_FIELDS = {
  dataDir: {
    label: '数据根目录',
    control: 'text',
    hint: '决定数据与覆盖文件的位置，改它等于换库；用启动参数或环境变量改。',
  },

  'providers.llm.default.type': {
    label: '类型',
    control: 'select',
    options: LLM_TYPE_OPTIONS,
    hint: '写 OpenAI 兼容时，网关地址填完整的 API 根（通常以 /v1 结尾）。',
  },
  'providers.llm.default.baseUrl': {
    label: '网关地址',
    control: 'text',
    hint: '本地推理服务填 http://127.0.0.1:8089/v1；远程供应商填其 API 地址。',
  },
  'providers.llm.default.model': { label: '模型名', control: 'text' },
  'providers.llm.default.apiKey': { label: 'API 密钥', control: 'secret' },
  'providers.llm.default.maxTokens': { label: '单次最大 token 数', control: 'number' },
  'providers.llm.default.timeoutSeconds': { label: '超时（秒）', control: 'number' },
  'providers.llm.default.pricing.inputPerMillion': {
    label: '输入价格（每百万 token）',
    control: 'number',
  },
  'providers.llm.default.pricing.outputPerMillion': {
    label: '输出价格（每百万 token）',
    control: 'number',
  },

  'providers.embedding.type': {
    label: '类型',
    control: 'select',
    options: EMBEDDING_TYPE_OPTIONS,
    hint: '「本地」与「远程」都是 OpenAI 兼容类型，区别只在网关地址：本地推理服务指向 127.0.0.1:8089 之类，远程供应商指向其地址。',
  },
  'providers.embedding.baseUrl': {
    label: '网关地址',
    control: 'text',
    hint: '本地推理服务填 http://127.0.0.1:8089/v1；远程供应商填其地址。',
  },
  'providers.embedding.model': { label: '模型名', control: 'text' },
  'providers.embedding.apiKey': { label: 'API 密钥', control: 'secret' },
  'providers.embedding.dimension': {
    label: '向量维度',
    control: 'number',
    hint: '必须与模型一致；写错要到第一次嵌入时才报错。',
  },
  'providers.embedding.maxBatchSize': { label: '单次请求条数上限', control: 'number' },
  'providers.embedding.timeoutSeconds': { label: '超时（秒）', control: 'number' },
  'providers.embedding.cache.enabled': { label: '启用嵌入缓存', control: 'boolean' },
  'providers.embedding.cache.maxEntries': { label: '缓存最多保留条数', control: 'number' },

  'providers.rerank.type': {
    label: '类型',
    control: 'select',
    options: RERANK_TYPE_OPTIONS,
    hint: 'HTTP 走 Cohere / Jina 兼容的 POST /rerank 接口。',
  },
  'providers.rerank.baseUrl': { label: '网关地址', control: 'text' },
  'providers.rerank.model': { label: '模型名', control: 'text' },
  'providers.rerank.apiKey': { label: 'API 密钥', control: 'secret' },
  'providers.rerank.timeoutSeconds': { label: '超时（秒）', control: 'number' },
  'providers.rerank.topN': {
    label: '候选条数上限',
    control: 'number',
    hint: '送去重排的候选条数；开启重排时按它放宽候选集。',
  },

  'retrieval.engine': {
    label: '检索引擎',
    control: 'select',
    options: RETRIEVAL_ENGINE_OPTIONS,
    hint: '语义与混合需要先配置向量供应商，否则启动期校验失败。',
  },
  'retrieval.candidateMultiplier': { label: '候选倍数', control: 'number' },
  'retrieval.levelWeights.l0': { label: 'L0 层级权重', control: 'number' },
  'retrieval.levelWeights.l1': { label: 'L1 层级权重', control: 'number' },
  'retrieval.levelWeights.l2': { label: 'L2 层级权重', control: 'number' },
  'retrieval.queryFilters': {
    label: '查询过滤正则',
    control: 'list',
    hint: '每行一条 sed 风格正则，作用在 prompt 上；暂不开放写入。',
  },
  'retrieval.assembly.maxTokens': { label: '注入 token 预算', control: 'number' },
  'retrieval.assembly.dedupTurns': { label: '去重轮数', control: 'number' },
  'retrieval.assembly.quotaPreset': {
    label: '配额预设',
    control: 'select',
    options: QUOTA_PRESET_OPTIONS,
  },
  'retrieval.rerank.enabled': { label: '启用重排', control: 'boolean' },
  'retrieval.rerank.keepTopN': {
    label: '重排后保留条数',
    control: 'number',
    hint: '0 表示只重排、不截断。',
  },

  'memory.reviewRequired': {
    label: '需要复核的记忆类型',
    control: 'list',
    hint: '每行一个类型；未列出的类型复核后直接生效。',
  },
  'memory.profile.maxChars': { label: '画像字数上限', control: 'number' },
  'memory.workingMemory.enabled': {
    label: '启用工作记忆',
    control: 'boolean',
    hint: '开它会多一次模型调用。',
  },
  'memory.ttl.defaultDays': { label: '默认过期天数', control: 'number' },
  'memory.ttl.sweepBatchSize': { label: '每轮清扫条数', control: 'number' },
  'memory.ttl.retentionDays': { label: '归档后保留天数', control: 'number' },
  'memory.consolidation.enabled': {
    label: '启用记忆合并',
    control: 'boolean',
    hint: '合并会删除记忆，是破坏性操作。',
  },
  'memory.consolidation.maxIterations': { label: '合并探索轮次上限', control: 'number' },

  'session.autoCommit.enabled': { label: '自动提交', control: 'boolean' },
  'session.autoCommit.pendingTokenThreshold': { label: '待提交 token 阈值', control: 'number' },
  'session.autoCommit.messageCountThreshold': { label: '待提交消息数阈值', control: 'number' },
  'session.autoCommit.minCommitIntervalSeconds': { label: '最小提交间隔（秒）', control: 'number' },
  'session.autoCommit.idleTimeoutSeconds': {
    label: '空闲提交超时（秒）',
    control: 'number',
    hint: '0 表示关闭；开启后需要服务端扫描器。',
  },
  'session.autoCommit.keepRecentCount': { label: '保留最近消息条数', control: 'number' },
  'session.expiry.idleTimeoutSeconds': {
    label: '空闲归档超时（秒）',
    control: 'number',
    hint: '与「空闲提交超时」是两件事；0 表示关闭。',
  },
  'session.expiry.action': {
    label: '空闲后动作',
    control: 'select',
    options: EXPIRY_ACTION_OPTIONS,
  },

  'task.leaseSeconds': { label: '任务租约（秒）', control: 'number' },
  'task.maxAttempts': { label: '最大尝试次数', control: 'number' },
  'task.concurrency': { label: '并发数', control: 'number' },

  'telemetry.metrics.enabled': { label: '启用指标', control: 'boolean' },
  'telemetry.metrics.includeAccountLabel': { label: '指标带账号标签', control: 'boolean' },
  'telemetry.requestLog.enabled': { label: '记录请求日志', control: 'boolean' },
  'telemetry.requestLog.retainDays': { label: '日志保留天数', control: 'number' },
  'telemetry.requestLog.retainRows': { label: '日志保留行数', control: 'number' },
  'telemetry.requestLog.sampleRate': { label: '采样率', control: 'number' },
  'telemetry.hookOverhead.enabled': { label: '上报自动采集开销', control: 'boolean' },
  'telemetry.hotness.halfLifeHours': { label: '热度半衰期（小时）', control: 'number' },
  'telemetry.hotness.weight': {
    label: '热度权重',
    control: 'number',
    hint: '0 表示只用于冷热标记，1 表示与检索分同权。',
  },

  'server.host': { label: '监听地址', control: 'text' },
  'server.port': { label: '监听端口', control: 'number' },
  'server.subject': {
    label: '回环信任主体',
    control: 'text',
    hint: '形如 user:local；回环信任打开时，不带凭据的本机请求被认证成它。',
  },

  'auth.trustLoopback': {
    label: '回环信任',
    control: 'boolean',
    hint: '认证边界；只能在监听回环地址时打开，容器部署必须关掉。',
  },
  'auth.adminUserIds': {
    label: '系统管理员',
    control: 'list',
    hint: '每行一个用户 ID；留空表示没有系统管理员。',
  },
  'auth.sessionSecret': { label: '会话签名密钥', control: 'secret' },
  'auth.sessionTtlSeconds': { label: '会话有效期（秒）', control: 'number' },

  'ingest.enabled': { label: '启用对话导入', control: 'boolean' },
  'ingest.batchSize': { label: '每批读取消息条数', control: 'number' },
  'ingest.extractionBatchSize': { label: '每批抽取会话数', control: 'number' },
  'ingest.extractionTimeoutMs': { label: '每批抽取超时（毫秒）', control: 'number' },
  'ingest.paths.claude-code': {
    label: 'Claude Code 对话目录',
    control: 'list',
    hint: '每行一个路径；留空用宿主默认位置。',
  },
  'ingest.paths.codex': {
    label: 'Codex 对话目录',
    control: 'list',
    hint: '每行一个路径；留空用宿主默认位置。',
  },
  'ingest.paths.deepseek': {
    label: 'DeepSeek 导出文件',
    control: 'list',
    hint: '每行一个文件路径；留空用宿主默认位置。',
  },
  'ingest.paths.qwen': {
    label: 'Qwen 导出文件',
    control: 'list',
    hint: '每行一个文件路径；留空用宿主默认位置。',
  },

  'logging.level': {
    label: '日志级别',
    control: 'select',
    options: LOG_LEVEL_OPTIONS,
  },
  'logging.file': { label: '错误日志文件', control: 'text' },

  'summary.generator': {
    label: '摘要生成方式',
    control: 'select',
    options: SUMMARY_GENERATOR_OPTIONS,
  },
  'summary.abstractMaxChars': { label: '摘要字数上限', control: 'number' },
  'summary.overviewMaxChars': { label: '总览字数上限', control: 'number' },

  'acl.groupDefaultLevel': {
    label: '组空间默认级别',
    control: 'select',
    options: ACL_LEVEL_OPTIONS,
  },
} satisfies Record<string, SettingField>

/**
 * 路径 → 字段定义。
 *
 * 类型是 `Record<string, SettingField>` 而不是精确键联合：服务端与客户端各自
 * 发版时，未知路径应该显示成路径本身（见 `settingFieldOf`），而不是让页面在
 * 访问不存在的键时抛错。
 */
const FIELD_INDEX: Readonly<Record<string, SettingField>> = SETTING_FIELDS

/** 未知路径的兜底：标签退回路径，控件按文本处理。 */
function settingFieldOf(path: string): SettingField {
  return FIELD_INDEX[path] ?? { label: path, control: 'text' }
}

/** 字段的中文名。路径只作为小字显示，不占标签位。 */
export function fieldLabelOf(path: string): string {
  return settingFieldOf(path).label
}

/** 字段的控件定义。 */
export function fieldControlOf(path: string): SettingControl {
  return settingFieldOf(path).control
}

/** 字段的选项；非 `select` 为空。 */
export function fieldOptionsOf(path: string): readonly SettingOption[] {
  return settingFieldOf(path).options ?? []
}

/** 字段的说明。 */
export function fieldHintOf(path: string): string | null {
  return settingFieldOf(path).hint ?? null
}

/** 分组标题。 */
export function groupLabelOf(group: ConfigGroup): string {
  return GROUP_LABELS[group]
}

/** 来源徽章文案。 */
export function sourceLabelOf(source: ConfigSource): string {
  return SOURCE_LABELS[source]
}

/** 来源徽章配色。 */
export function sourceToneOf(source: ConfigSource): 'gray' | 'blue' | 'teal' | 'orange' {
  return SOURCE_TONES[source]
}

/** 来源的一句话解释，作为徽章的 `title`。 */
export function sourceNoteOf(source: ConfigSource): string {
  return SOURCE_NOTES[source]
}

/** 首屏展开的分组。其余分组折叠，避免 84 个控件一次铺满。 */
export const INITIALLY_EXPANDED_GROUPS: ReadonlySet<ConfigGroup> = new Set<ConfigGroup>([
  'llm',
  'embedding',
  'rerank',
])

/** 分组默认是否展开。 */
export function isExpandedByDefault(group: ConfigGroup): boolean {
  return INITIALLY_EXPANDED_GROUPS.has(group)
}

export interface SettingsGroupView {
  readonly group: ConfigGroup
  readonly label: string
  /** 三组模型供应商才有的连接测试目标；其它分组为 `null`。 */
  readonly testTarget: ConfigTestTarget | null
  readonly items: readonly ConfigItemView[]
}

/**
 * 按 `group` 分组。顺序固定为 `CONFIG_GROUPS`，空分组不渲染。
 *
 * 服务端按默认值顺序返回 84 项，直接铺开会让「模型 / 向量 / 重排」三组散在
 * 中间。这里按分组重排一次，页面只负责渲染。
 */
export function groupSettings(items: readonly ConfigItemView[]): readonly SettingsGroupView[] {
  const groups: SettingsGroupView[] = []
  for (const group of CONFIG_GROUPS) {
    const groupItems = items.filter((item) => item.group === group)
    if (groupItems.length > 0) {
      groups.push({
        group,
        label: GROUP_LABELS[group],
        testTarget: isConfigTestTarget(group) ? group : null,
        items: groupItems,
      })
    }
  }
  return groups
}

/** 空值文案。空串与空数组是「没有设置」，不是「没有这一项」。 */
const EMPTY_VALUE = '（空）'

/** 不可暴露项的占位。 */
const HIDDEN_VALUE = '—'

/**
 * 密钥类显示：`已设置 ····1234` / `未设置`。
 *
 * **不读 `item.value`。** 服务端契约里密钥的 `value` 恒为 `null`；这里再忽略一次，
 * 是为了让「服务端误把明文放进响应」也不会出现在页面上。掩码是服务端给的
 * `****1234`，把星号换成中点：星号在等宽字体里像占位符，中点更像「被遮住的部分」。
 */
export function secretDisplayOf(item: Pick<ConfigItemView, 'configured' | 'masked'>): string {
  if (!item.configured) {
    return '未设置'
  }
  if (item.masked === null) {
    return '已设置'
  }
  return `已设置 ${item.masked.replace(/^\*+/u, '····')}`
}

/** 当前值文案。密钥类走 `secretDisplayOf`，其它原样显示。 */
export function valueDisplayOf(item: ConfigItemView): string {
  if (item.secret) {
    return secretDisplayOf(item)
  }
  if (item.value === null || item.value === undefined) {
    return HIDDEN_VALUE
  }
  if (Array.isArray(item.value)) {
    const values = item.value.map((value) => String(value))
    return values.length === 0 ? EMPTY_VALUE : values.join('、')
  }
  if (typeof item.value === 'boolean') {
    return item.value ? '开启' : '关闭'
  }
  if (typeof item.value === 'number') {
    return String(item.value)
  }
  if (item.value === '') {
    return EMPTY_VALUE
  }
  return String(item.value)
}

/** 输入框的初始草稿。密钥类留空（留空 = 不改），数组每行一个。 */
export function draftOf(item: ConfigItemView): string {
  if (item.secret) {
    return ''
  }
  if (item.value === null || item.value === undefined) {
    return ''
  }
  if (Array.isArray(item.value)) {
    return item.value.map((value) => String(value)).join('\n')
  }
  return String(item.value)
}

/** 一次保存的请求体与字段级错误。 */
export interface PatchPreview {
  readonly values: Readonly<Record<string, unknown>>
  readonly errors: Readonly<Record<string, string>>
}

/**
 * 把草稿转成 `PATCH /config` 的 `values`。
 *
 * 三条规则：
 *
 * 1. **只提交改动过的可编辑项。** 没动过的字段不写覆盖文件，否则第一次保存就会把
 *    84 个默认值全部固化进覆盖文件，以后升级默认值不再生效。
 * 2. **密钥留空 = 不改。** 要清除必须显式点「清除」（写 `""`）。
 * 3. **类型按字段定义转。** 数字转 `number`，开关转 `boolean`，列表按行拆成
 *    `string[]`。转换失败不提交，错误回到字段旁。
 */
export function buildPatchValues(
  items: readonly ConfigItemView[],
  drafts: Readonly<Record<string, string>>,
  cleared: ReadonlySet<string> = new Set(),
): PatchPreview {
  const values: Record<string, unknown> = {}
  const errors: Record<string, string> = {}

  for (const item of items) {
    if (!item.editable) {
      continue
    }

    const control = fieldControlOf(item.path)
    const draft = drafts[item.path] ?? ''

    if (control === 'secret') {
      if (cleared.has(item.path)) {
        values[item.path] = ''
        continue
      }
      // 留空 = 不改。密钥可能有前导空白，不 trim。
      if (draft === '') {
        continue
      }
      values[item.path] = draft
      continue
    }

    if (control === 'boolean') {
      if (draft === String(item.value)) {
        continue
      }
      values[item.path] = draft === 'true'
      continue
    }

    if (control === 'list') {
      const list = draft
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
      if (JSON.stringify(list) === JSON.stringify(item.value)) {
        continue
      }
      values[item.path] = list
      continue
    }

    if (control === 'number') {
      const text = draft.trim()
      if (text === '') {
        errors[item.path] = '请填写数字。'
        continue
      }
      const parsed = Number(text)
      if (!Number.isFinite(parsed)) {
        errors[item.path] = '请填写有效的数字。'
        continue
      }
      if (parsed === item.value) {
        continue
      }
      values[item.path] = parsed
      continue
    }

    if (control === 'select') {
      const allowed = fieldOptionsOf(item.path).map((option) => option.value)
      if (allowed.length > 0 && !allowed.includes(draft)) {
        errors[item.path] = '请从列表里选择。'
        continue
      }
      if (draft === item.value) {
        continue
      }
      values[item.path] = draft
      continue
    }

    if (draft === item.value) {
      continue
    }
    values[item.path] = draft
  }

  return { values, errors }
}

/**
 * 保存失败时把错误挂到哪个字段。
 *
 * 服务端在 `INVALID_ARGUMENT` 的 `details.field` 里点名路径（环境变量遮住、
 * 类型不符、不在白名单）。`details` 缺失时退回到消息里找路径——错误原文要原样
 * 显示，不能因为拿不到 `details` 就只剩一句「请求失败」。
 */
export function fieldPathOfError(
  message: string,
  details: unknown,
  knownPaths: readonly string[],
): string | null {
  if (isRecord(details) && typeof details['field'] === 'string') {
    const field = details['field']
    if (knownPaths.includes(field)) {
      return field
    }
  }
  for (const path of knownPaths) {
    if (message.includes(path)) {
      return path
    }
  }
  return null
}

/**
 * 保存失败时错误旁的补充说明。
 *
 * 服务端原文已经点名环境变量，但「环境变量优先于这一页」这条优先级规则不在错误
 * 原文里。隐藏它会让用户以为「再点一次保存」就能覆盖。
 */
export function errorHintOf(message: string | null): string | null {
  if (message === null) {
    return null;
  }
  return message.includes('环境变量') ? '环境变量优先于本页设置；改环境变量后重启进程。' : null;
}

/** 保存成功后的提示条。`restartRequired` 恒为真，文案不说「已应用」。 */
export function restartNoticeOf(overridePath: string): string {
  return `设置已保存到 ${overridePath}。需要重启 CoMem 才能生效——配置只在启动时读一次。`
}

/** 两种部署形态的重启命令。复制按钮由 `DomainCodeBlock` 提供。 */
export const RESTART_COMMANDS = [
  { id: 'dev', label: '开发（pnpm dev）', command: 'pnpm dev' },
  { id: 'docker', label: '容器（docker compose）', command: 'docker compose restart comem' },
] as const

/** 连接测试的固定说明。这句不能省：否则「保存 + 测试通过」会被当成已生效。 */
export const TEST_SCOPE_NOTE =
  '「测试连接」测的是当前正在运行的配置，不是刚保存、还没重启的配置。'

/** 连接测试的一行摘要：通过 / 失败 + 耗时。`detail` 另起一行原样显示。 */
export function testSummaryOf(result: ConfigTestPayload): string {
  return `${result.ok ? '通过' : '失败'} · ${result.latencyMs} ms`
}

/** 分组是否是三组可测试的模型供应商之一。 */
export function isConfigTestTarget(group: ConfigGroup): group is ConfigTestTarget {
  return (CONFIG_TEST_TARGETS as readonly string[]).includes(group)
}
