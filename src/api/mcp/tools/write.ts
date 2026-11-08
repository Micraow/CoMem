/**
 * `write`：写正文（架构文档 §10.6、§13.2）。
 *
 * 三种模式：
 * - `replace`：覆盖正文，保留磁盘上现有的 frontmatter（§10.6 元数据写保护）；
 * - `append`：只追加正文，同样不碰 frontmatter；
 * - `create`：目标已存在时抛 `ALREADY_EXISTS`，用于「只在没有时创建」。
 *
 * ## `frontmatter` 是一等公民，不是正文里的 `---` 块
 *
 * 记忆文件的元数据（`memory_type` / `status` / 各类型字段）必须走 `frontmatter`
 * 参数。曾经的做法是把 `---` 开头的 YAML 块**内嵌在 `content` 里**：它只在
 * `serializeDocument(body, {})` 的「空 data 原样返回」分支上碰巧成立，正文里恰好
 * 以 `---` 开头的代码块还会被当成 frontmatter 解析。
 *
 * 现在的契约：
 *
 * - **传 `frontmatter`**：整份文档按「frontmatter + 正文」写入，落盘后 `readText`
 *   解析出同样的键值。`memory_type` 与 `status` 在这里校验。
 * - **不传**：与改动前逐字节相同（`content` 原样落盘）。
 *
 * `content` 是**正文**。不传 `frontmatter` 时，以 `---` 开头的正文会被当成
 * frontmatter 的开头（文件格式决定的），所以直接拒绝并提示用 `frontmatter` 参数。
 *
 * `wait` 是给「写后立刻读」的调用方的：观察者是同步调用的，返回时索引已经更新；
 * 传 true 只影响日志，不改变行为。
 */

import { stringify as stringifyYaml } from 'yaml';

import { ComemError } from '../../../domain/errors.js';
import { getMemoryType } from '../../../domain/memory-types/index.js';
import { Uri } from '../../../domain/uri.js';
import type { MemoryStatus } from '../../../services/memory.js';
import type { McpToolContext } from '../context.js';
import {
  asRecord,
  indexStatus,
  optionalBoolean,
  optionalEnum,
  requiredString,
  textResult,
  type McpToolDefinition,
} from '../registry.js';

const MODES = ['replace', 'append', 'create'] as const;

type WriteMode = (typeof MODES)[number];

/** 记忆文件的状态（§11.6 的复核闸门）。 */
const STATUSES: readonly MemoryStatus[] = ['active', 'pending', 'archived'];

/** frontmatter 的键是磁盘上的 YAML 键（§6.6）：`memory_type`，不是 `memoryType`。 */
const MEMORY_TYPE_KEY = 'memory_type';
const STATUS_KEY = 'status';

/** 整份文档的 frontmatter 键值。未知键原样保留。 */
type Frontmatter = Record<string, unknown>;

/** 文件格式的开分隔符（`adapters/fs/frontmatter.ts` 同一套字面量）。 */
const FRONTMATTER_DELIMITER = '---';

function invalidArgument(message: string, details: Record<string, unknown>): ComemError {
  return new ComemError('INVALID_ARGUMENT', message, details);
}

/**
 * 拼回「YAML frontmatter + 正文」。
 *
 * 与 `adapters/fs/frontmatter.ts` 的 `serializeDocument` 同一格式。`api/` 不能值
 * 导入适配层（§4.2），`services/memory.ts` 又只覆盖记忆文件的固定键序，所以这里
 * 维护一份最小实现——集成测试用 `readText` 的往返结果钉住两份实现没有漂移。
 *
 * `lineWidth: 0` 关掉折行：长 URI 被折断后读回来是另一个字符串。
 */
function serializeDocument(body: string, frontmatter: Readonly<Frontmatter>): string {
  if (Object.keys(frontmatter).length === 0) {
    return body;
  }
  const yamlText = stringifyYaml(frontmatter, { lineWidth: 0 });
  return `${FRONTMATTER_DELIMITER}\n${yamlText}${FRONTMATTER_DELIMITER}\n\n${body}`;
}

/** `frontmatter` 必须是普通对象；未传返回 `undefined`（与「传空对象」同义）。 */
function optionalFrontmatter(input: Record<string, unknown>): Frontmatter | undefined {
  const value = input['frontmatter'];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidArgument('write 的 frontmatter 必须是对象。', { field: 'frontmatter' });
  }
  return value as Frontmatter;
}

/**
 * 校验记忆类型的两个受控键。
 *
 * 未知字段**放行**：将来给记忆加字段不需要改这里，`readText` 会原样读回。校验只
 * 覆盖「写错了要到检索时才发现」的两个键——`memory_type` 决定目录与合并策略，
 * `status` 决定复核闸门。
 */
function assertFrontmatter(frontmatter: Frontmatter): void {
  const memoryType = frontmatter[MEMORY_TYPE_KEY];
  if (memoryType !== undefined) {
    if (typeof memoryType !== 'string' || getMemoryType(memoryType) === undefined) {
      throw invalidArgument(
        `frontmatter.${MEMORY_TYPE_KEY} 不是内置记忆类型：${String(memoryType)}。`,
        { field: MEMORY_TYPE_KEY, value: memoryType },
      );
    }
  }

  const status = frontmatter[STATUS_KEY];
  if (status !== undefined) {
    if (typeof status !== 'string' || !STATUSES.includes(status as MemoryStatus)) {
      throw invalidArgument(
        `frontmatter.${STATUS_KEY} 只能是 ${STATUSES.join(' / ')}。`,
        { field: STATUS_KEY, value: status },
      );
    }
  }
}

/**
 * `content` 是正文。以 `---` 开头时它会被文件格式当成 frontmatter 的开头
 * （`parseDocument` 只认第一行），元数据会静默变成正文——所以在这里拒绝。
 */
function assertBodyContent(content: string): void {
  const firstLineBreak = content.indexOf('\n');
  if (firstLineBreak < 0) {
    return;
  }
  const firstLine = content.slice(0, firstLineBreak).replace(/\r$/, '');
  if (firstLine === FRONTMATTER_DELIMITER) {
    throw invalidArgument(
      'write 的 content 是正文，不能以 `---` 开头（会被解析成 frontmatter）；元数据用 frontmatter 参数传。',
      { field: 'content' },
    );
  }
}

/** `append` / `create` 需要先读现有正文；不存在按空串处理。 */
async function readExisting(context: McpToolContext, uri: Uri): Promise<string> {
  try {
    return (await context.filesystem.read(uri)).text;
  } catch (error) {
    if (error instanceof ComemError && error.code === 'NOT_FOUND') {
      return '';
    }
    throw error;
  }
}

export const writeTool: McpToolDefinition = {
  name: 'write',
  kind: 'write',
  description:
    '需要新建文件或整段替换正文时用这个；只改一小段用 edit 更安全，它不会覆盖没读到的内容。mode=create 在目标已存在时报错，append 只追加正文、保留 frontmatter。写记忆时用 frontmatter 传 memory_type / status 等元数据，不要把它们塞进 content。返回写入字节数、是否新建与索引状态；索引状态是 pending 时说明检索暂时看不到这个文件。',
  inputSchema: {
    type: 'object',
    properties: {
      uri: { type: 'string', description: '文件 URI' },
      content: { type: 'string', description: '正文；空串表示写空文件' },
      mode: { type: 'string', enum: MODES, default: 'replace' },
      frontmatter: {
        type: 'object',
        additionalProperties: true,
        description:
          'frontmatter 键值（磁盘上的 YAML 键：memory_type、status、topic 等）。传了它整份文档按「frontmatter + 正文」写入；append 模式不接受。',
      },
      wait: { type: 'boolean', default: false, description: '写后是否等待索引更新' },
    },
    required: ['uri', 'content'],
  },
  async execute(input, context) {
    const args = asRecord(input, 'write');
    const uri = Uri.parse(requiredString(args, 'uri', 'write'));
    const content = requiredString(args, 'content', 'write');
    const mode = optionalEnum(args, 'mode', MODES, 'replace', 'write');
    const frontmatter = optionalFrontmatter(args);
    const wait = optionalBoolean(args, 'wait', false, 'write');

    if (frontmatter !== undefined) {
      assertFrontmatter(frontmatter);
      if (mode === 'append') {
        throw invalidArgument(
          'append 只追加正文、不解析 frontmatter；要替换 frontmatter 用 replace 或 create。',
          { field: 'frontmatter', mode },
        );
      }
    }

    const result = await writeWithMode(context, uri, content, mode, frontmatter);
    const index = await indexStatus(context, uri, 'indexed');
    const bytes =
      frontmatter === undefined
        ? Buffer.byteLength(content, 'utf8')
        : Buffer.byteLength(serializeDocument(content, frontmatter), 'utf8');
    context.logger.debug('MCP write 完成', {
      requestId: context.requestId,
      uri: uri.toString(),
      mode,
      frontmatter: frontmatter !== undefined,
      wait,
    });

    return textResult(
      `Wrote ${bytes} byte(s) to ${uri.toString()} (mode: ${mode}, created: ${String(result.created)})\nIndex: ${index}`,
    );
  },
};

async function writeWithMode(
  context: McpToolContext,
  uri: Uri,
  content: string,
  mode: WriteMode,
  frontmatter: Frontmatter | undefined,
): Promise<{ readonly created: boolean }> {
  switch (mode) {
    case 'replace': {
      if (frontmatter !== undefined) {
        return context.filesystem.writeDocument(uri, serializeDocument(content, frontmatter));
      }
      assertBodyContent(content);
      return context.filesystem.write(uri, content);
    }
    case 'append': {
      const existing = await readExisting(context, uri);
      // 空文件追加后文件从 `---` 开始，会被当成 frontmatter；已有正文时不存在这个
      // 问题（`parseDocument` 只看第一行）。
      if (existing === '') {
        assertBodyContent(content);
      }
      return context.filesystem.write(uri, `${existing}${content}`);
    }
    case 'create': {
      if ((await context.filesystem.stat(uri)) !== null) {
        throw new ComemError('ALREADY_EXISTS', `目标已存在：${uri.toString()}`, {
          uri: uri.toString(),
        });
      }
      if (frontmatter !== undefined) {
        return context.filesystem.writeDocument(uri, serializeDocument(content, frontmatter));
      }
      assertBodyContent(content);
      return context.filesystem.write(uri, content);
    }
  }
}
