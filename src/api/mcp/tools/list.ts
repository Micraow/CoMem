/**
 * `list`：列目录直接子项（架构文档 §12.4、§13.2）。
 *
 * 无权限的节点完全不出现（§12.4 的列表语义）——`FileSystemService.list` 已经逐条
 * 求过 read 权限，这里不再二次过滤。
 *
 * `recursive` 用 `tree` 的实现（同样逐条求权、同样按 TREE 锁），不自己递归 open
 * 目录：§8.2 的硬伤就是「一条候选 open 5 层目录」。
 */

import type { TreeEntry } from '../../../services/filesystem.js';
import { Uri } from '../../../domain/uri.js';
import {
  asRecord,
  nonNegativeInteger,
  optionalBoolean,
  optionalEnum,
  readLimit,
  requiredString,
  textResult,
  type McpToolDefinition,
} from '../registry.js';

/** 递归列目录的深度上限。经验值：再深的目录树用户也不会逐条读。 */
const RECURSIVE_DEPTH = 64;

/** 递归列目录的节点上限。与 `FileSystemService.tree` 的默认值一致。 */
const RECURSIVE_LIMIT = 1000;

const SORT_ORDERS = ['name', 'name_desc', 'size', 'size_desc'] as const;

type SortOrder = (typeof SORT_ORDERS)[number];

function compareEntries(left: TreeEntry, right: TreeEntry, order: SortOrder): number {
  switch (order) {
    case 'name':
      return left.uri.name.localeCompare(right.uri.name);
    case 'name_desc':
      return right.uri.name.localeCompare(left.uri.name);
    case 'size':
      return left.size - right.size;
    case 'size_desc':
      return right.size - left.size;
  }
}

function displayName(entry: TreeEntry, root: Uri): string {
  return entry.uri.segments.slice(root.segments.length).join('/');
}

export const listTool: McpToolDefinition = {
  name: 'list',
  kind: 'read',
  description:
    '想看某个目录下有什么时用这个，只看一层；要整棵子树用 tree。recursive=true 会展开子树但只返回扁平列表，路径是相对列目录根的名字。sortBy 支持 name / size 及对应的 _desc 变体，offset 与 limit 在排序之后生效。',
  inputSchema: {
    type: 'object',
    properties: {
      uri: { type: 'string', description: '目录 URI' },
      recursive: { type: 'boolean', default: false, description: '是否展开子树' },
      offset: { type: 'integer', minimum: 0, default: 0 },
      limit: { type: 'integer', description: '最多返回条数；-1 表示全部', default: -1 },
      sortBy: { type: 'string', enum: SORT_ORDERS, default: 'name' },
    },
    required: ['uri'],
  },
  async execute(input, context) {
    const args = asRecord(input, 'list');
    const uri = Uri.parse(requiredString(args, 'uri', 'list'));
    const recursive = optionalBoolean(args, 'recursive', false, 'list');
    const offset = nonNegativeInteger(args, 'offset', 0, 'list');
    const limit = readLimit(args, 'limit', -1, 'list');
    const sortBy = optionalEnum(args, 'sortBy', SORT_ORDERS, 'name', 'list');

    const entries = recursive
      ? (
          await context.filesystem.tree(uri, context.principals, {
            depth: RECURSIVE_DEPTH,
            limit: RECURSIVE_LIMIT,
          })
        ).entries
      : await context.filesystem.list(uri, context.principals);

    const sorted = [...entries].sort((left, right) => compareEntries(left, right, sortBy));
    const page = sorted.slice(offset, limit < 0 ? undefined : offset + limit);

    const lines = page.map((entry) => {
      const kind = entry.kind === 'directory' ? '[dir]' : '[file]';
      return `${kind} ${displayName(entry, uri)}`;
    });
    if (lines.length === 0) {
      return textResult('(empty)');
    }
    return textResult(lines.join('\n'));
  },
};
