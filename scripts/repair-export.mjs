#!/usr/bin/env node
/**
 * 修复被脱敏破坏的 JSON / JSONL 导出文件。
 *
 * ## 损坏是什么
 *
 * 导出前跑过一道脱敏：把「像密钥的东西」就地替换成占位符 `密码保护`。占位符是
 * **连长度都不保证**的内联替换——`sk-ant-...` 的 `sk-`、手机号中间四位、弱口令
 * `123456`、UUID 里的一段十六进制，都可能是被替换掉的那一段：
 *
 *   "password": "密码保护"                 ← 整个字符串值被替换（合法）
 *   "anthropic_api_key": "密码保护ant-..."  ← 原值以 sk- 开头（合法）
 *   "total_tokens": 162密码保护27           ← 数字中间一段被替换（**非法**）
 *   "create_time": 1791275310.6密码保护9     ← 小数点后一段被替换（**非法**）
 *
 * 前两种不破坏语法，只丢信息；后两种让 JSON 解析器直接报错。
 *
 * ## 为什么不是「还原原值」
 *
 * 占位符没有携带长度、类型或校验位，`162密码保护27` 可能是 9 位数里的任意四位。
 * 原值**永久丢失**。本工具的目标只有两个：
 *
 * 1. 让 JSON 重新可解析；
 * 2. 保留所有未被破坏的信息（对话正文、时间戳整数部分、其余字段原样）。
 *
 * ## 替换成什么
 *
 * 数字位置上的**整个畸形数字字面量**替换成 `--number-replacement`，默认 `null`。
 *
 * 不用 `0` 是刻意的：`"create_time": 0` 是 1970-01-01，`"total_tokens": 0` 是
 * 「一个 token 都没用」，两者都是**看起来像真数据的假数据**——下游按时间排序会
 * 悄悄错位、按 token 计费会悄悄少算。`null` 合法、可判别（`value === null`）、
 * 不会被误当成测量值。需要字面遵守「替换成 0」的旧约定时传 `--number-replacement 0`。
 *
 * 注意：把 `密码保护` 直接替换成 `0` 是**错的**——`"total_tokens":密码保护5` 会变成
 * `05`，前导零本身就不是合法 JSON。所以替换的是整个数字字面量，不是占位符。
 *
 * ## 字符串里的 `密码保护` 一律原样保留
 *
 * 它本来就是字符串，不破坏语法；而且那正是脱敏想要的结果。副作用是脱敏误伤了
 * 一部分非密钥文本（例如 `Flask-RESTful` → `Fla密码保护RESTful`），本工具不做
 * 猜测性回填，只在报告里计数。
 *
 * ## 安全
 *
 * - 源目录只读，所有写入都落在 `--out`。
 * - `--out` 等于 `--root` 或位于 `--root` 内部时直接报错退出。
 * - 写盘前检查剩余空间（源体积的 1.2 倍）。
 * - 修复后的文件重新解析一遍才计入成功；任何一个不合法都以退出码 1 结束。
 *
 * ## 流式
 *
 * JSONL（占本仓库 694 MB / 810 MB，单文件最大 206 MB）逐行流式处理，内存里只留
 * 当前行。整份 `.json`（单文件最大 36 MB）必须全量读取：单个 JSON 文档没有行语义，
 * 而且「修复后重新解析一遍」这个验收动作本身就需要完整文本来 `JSON.parse`。
 *
 * 用法：
 *   node scripts/repair-export.mjs --root "/home/micraow/Downloads/AI对话" \
 *     --out "/home/micraow/Downloads/AI对话-repaired"
 *   node scripts/repair-export.mjs --root ... --dry-run   # 只清点，不写盘
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';

// ── 常量 ──────────────────────────────────────────────────────────────────

/** 脱敏占位符。它不是 JSON 的合法 token，出现在字符串外就是语法错误。 */
const MARK = '密码保护';

/** `.json` 是整份文档，`.jsonl` 是逐行记录。 */
const JSON_EXTENSIONS = new Set(['.json']);
const JSONL_EXTENSIONS = new Set(['.jsonl']);

/** 允许的替换值：JSON 字面量文本。 */
const NUMBER_REPLACEMENTS = new Map([
  ['null', 'null'],
  ['0', '0'],
]);

const DEFAULT_ROOT = '/home/micraow/Downloads/AI对话';
const DEFAULT_OUT = '/home/micraow/Downloads/AI对话-repaired';

/** 报告文件名。它们落在输出目录里，验证时要跳过自身。 */
const REPORT_JSON = 'repair-report.json';
const REPORT_MARKDOWN = 'repair-report.md';

/** 剩余空间低于源体积的这个倍数就拒绝执行。 */
const FREE_SPACE_FACTOR = 1.2;

const USAGE = `用法：node scripts/repair-export.mjs [选项]

  --root <目录>               源目录（只读）。默认 ${DEFAULT_ROOT}
  --out <目录>                输出目录。默认 ${DEFAULT_OUT}
  --number-replacement <值>   数字字面量的替换值，null 或 0。默认 null
  --dry-run                   只清点不写盘
  --help                      显示本帮助

退出码：0 全部合法 · 1 有文件仍然不合法 · 2 参数或环境错误`;

// ── 参数 ──────────────────────────────────────────────────────────────────

/**
 * `--key value` 与 `--flag` 两种形式。
 * @param {string[]} argv
 * @returns {Map<string, string | true>}
 */
function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      throw new Error(`无法解析的参数：${token}`);
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      args.set(name, true);
      continue;
    }
    args.set(name, next);
    index += 1;
  }
  return args;
}

/**
 * @param {Map<string, string | true>} args
 * @param {string} name
 * @returns {string | undefined}
 */
function stringArg(args, name) {
  const value = args.get(name);
  return typeof value === 'string' ? value : undefined;
}

// ── 路径安全 ──────────────────────────────────────────────────────────────

/**
 * `child` 是否等于 `parent` 或位于其内部。
 * @param {string} child
 * @param {string} parent
 * @returns {boolean}
 */
function isSelfOrInside(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * 拒绝把输出写进源目录。这是本脚本唯一的「不可逆操作」防线。
 * @param {string} root
 * @param {string} out
 */
function assertSafeOutput(root, out) {
  const rootAbs = resolve(root);
  const outAbs = resolve(out);
  if (isSelfOrInside(outAbs, rootAbs)) {
    throw new Error(
      `--out 不能是 --root 本身或其子目录（root=${rootAbs}，out=${outAbs}）。源目录只读，请换一个输出目录。`,
    );
  }
}

/**
 * 写盘前再确认一次：目标路径确实在输出目录里。
 * @param {string} targetPath
 * @param {string} outAbs
 */
function assertWritableTarget(targetPath, outAbs) {
  if (!resolve(targetPath).startsWith(`${outAbs}${sep}`)) {
    throw new Error(`拒绝写入输出目录之外：${targetPath}`);
  }
}

// ── 标记扫描 ──────────────────────────────────────────────────────────────

/**
 * 扫描文本里所有 `密码保护`，按「是否位于 JSON 字符串字面量内部」分成两组。
 * 字符串外的那组才是语法错误；字符串内的那组是脱敏的正常结果。
 *
 * @param {string} text
 * @returns {{ outside: number[], inside: number[] }} 起始下标
 */
function scanMarkers(text) {
  /** @type {number[]} */
  const outside = [];
  /** @type {number[]} */
  const inside = [];
  let inString = false;
  let escaped = false;
  let index = 0;
  while (index < text.length) {
    if (inString) {
      if (text.startsWith(MARK, index)) {
        inside.push(index);
        index += MARK.length;
        continue;
      }
      const char = text[index];
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }
    const char = text[index];
    if (char === '"') {
      inString = true;
      index += 1;
      continue;
    }
    if (text.startsWith(MARK, index)) {
      outside.push(index);
      index += MARK.length;
      continue;
    }
    index += 1;
  }
  return { outside, inside };
}

/**
 * 统计 `MARK` 的非重叠出现次数（不分配数组）。
 * @param {string} text
 * @returns {number}
 */
function countMarkers(text) {
  let count = 0;
  let index = text.indexOf(MARK);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(MARK, index + MARK.length);
  }
  return count;
}

/**
 * 快速判断一个文件里有没有标记。按 64 KiB 块读，避免为了「没有标记」这种常见
 * 情况把 200 MB 文件整个读进内存。
 *
 * @param {string} absolute
 * @returns {Promise<boolean>}
 */
async function fileContainsMarker(absolute) {
  const marker = Buffer.from(MARK, 'utf8');
  const input = createReadStream(absolute);
  /** @type {Buffer} */
  let carry = Buffer.alloc(0);
  for await (const chunk of input) {
    const window = Buffer.concat([carry, /** @type {Buffer} */ (chunk)]);
    if (window.includes(marker)) {
      input.destroy();
      return true;
    }
    carry = window.subarray(Math.max(0, window.length - (marker.length - 1)));
  }
  return false;
}

// ── 数字字面量 ────────────────────────────────────────────────────────────

/**
 * 数字字面量允许出现的字符。标记只会嵌在十进制字面量里，指数部分单独处理。
 * @param {string | undefined} char
 * @returns {boolean}
 */
function isNumberChar(char) {
  return char !== undefined && (char === '.' || (char >= '0' && char <= '9'));
}

/**
 * 从标记位置向两侧扩张到完整的数字字面量。
 * `162密码保护27` 会扩张成整个 `162密码保护27`；标记不在数字里时退化成标记本身。
 *
 * @param {string} text
 * @param {number} start 标记起点
 * @param {number} end 标记终点（不含）
 * @returns {[number, number]}
 */
function expandNumberLiteral(text, start, end) {
  let begin = start;
  let finish = end;
  while (begin > 0 && isNumberChar(text[begin - 1])) {
    begin -= 1;
  }
  while (finish < text.length && isNumberChar(text[finish])) {
    finish += 1;
  }
  // 指数部分：1e+12 / 1E12
  if (finish < text.length && (text[finish] === 'e' || text[finish] === 'E')) {
    let cursor = finish + 1;
    if (text[cursor] === '+' || text[cursor] === '-') {
      cursor += 1;
    }
    if (text[cursor] >= '0' && text[cursor] <= '9') {
      while (cursor < text.length && text[cursor] >= '0' && text[cursor] <= '9') {
        cursor += 1;
      }
      finish = cursor;
    }
  }
  // 正负号：只有紧跟在结构分隔符后面时才算字面量的一部分
  if (begin > 0 && (text[begin - 1] === '-' || text[begin - 1] === '+')) {
    const before = begin >= 2 ? text[begin - 2] : '';
    if (before === '' || /[\s:,[{]/u.test(before)) {
      begin -= 1;
    }
  }
  return [begin, finish];
}

/**
 * 取字面量所属的 JSON key，用于报告「哪个字段的值丢了」。
 * @param {string} text
 * @param {number} index 字面量起点
 * @returns {string | null}
 */
function enclosingKey(text, index) {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/u.test(text[cursor])) {
    cursor -= 1;
  }
  if (text[cursor] !== ':') {
    return null;
  }
  cursor -= 1;
  while (cursor >= 0 && /\s/u.test(text[cursor])) {
    cursor -= 1;
  }
  if (text[cursor] !== '"') {
    return null;
  }
  const closing = cursor;
  cursor -= 1;
  while (cursor >= 0) {
    if (text[cursor] === '"' && text[cursor - 1] !== '\\') {
      return text.slice(cursor + 1, closing);
    }
    cursor -= 1;
  }
  return null;
}

// ── 单文档修复 ────────────────────────────────────────────────────────────

/**
 * @typedef {object} LostValue
 * @property {number} line 行号（从 1 开始）
 * @property {string} literal 修复前的畸形字面量
 * @property {string | null} key 所属字段名
 */

/**
 * 把文本里所有字符串外的标记替换成占位值。
 *
 * @param {string} text
 * @param {string} replacement
 * @param {number} [baseLine] 文本第一行在源文件里的行号减一（JSONL 逐行调用时用）
 * @returns {{ text: string, outside: number, inside: number, lost: LostValue[] }}
 */
function repairText(text, replacement, baseLine = 0) {
  const { outside, inside } = scanMarkers(text);
  if (outside.length === 0) {
    return { text, outside: 0, inside: inside.length, lost: [] };
  }

  // 同一个数字字面量里可能连着两个标记（`1密码保护2密码保护3`），先合并区间。
  /** @type {Array<[number, number]>} */
  const ranges = [];
  for (const start of outside) {
    const [begin, finish] = expandNumberLiteral(text, start, start + MARK.length);
    const last = ranges[ranges.length - 1];
    if (last !== undefined && begin <= last[1]) {
      last[1] = Math.max(last[1], finish);
    } else {
      ranges.push([begin, finish]);
    }
  }

  /** @type {LostValue[]} */
  const lost = [];
  let output = '';
  let cursor = 0;
  for (const [begin, finish] of ranges) {
    output += text.slice(cursor, begin);
    output += replacement;
    let newlines = 0;
    for (let index = text.indexOf('\n'); index !== -1 && index < begin; index = text.indexOf('\n', index + 1)) {
      newlines += 1;
    }
    lost.push({
      line: baseLine + newlines + 1,
      literal: text.slice(begin, finish),
      key: enclosingKey(text, begin),
    });
    cursor = finish;
  }
  output += text.slice(cursor);
  return { text: output, outside: outside.length, inside: inside.length, lost };
}

/**
 * 数一个文件有多少非空行。只用于报告里的「记录数」，所以不解析。
 * @param {string} absolute
 * @returns {Promise<number>}
 */
async function countRecords(absolute) {
  const input = createReadStream(absolute, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  let count = 0;
  for await (const line of lines) {
    if (line.trim() !== '') {
      count += 1;
    }
  }
  return count;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function isValidJson(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// ── 文件遍历 ──────────────────────────────────────────────────────────────

/**
 * @typedef {object} SourceFile
 * @property {string} absolute 绝对路径
 * @property {string} path 相对源目录的路径（统一用 `/`）
 * @property {number} bytes
 * @property {'json' | 'jsonl' | 'other'} kind
 */

/**
 * @param {string} rootAbs
 * @returns {Promise<SourceFile[]>}
 */
async function listFiles(rootAbs) {
  /** @type {SourceFile[]} */
  const files = [];
  /**
   * @param {string} directory
   * @returns {Promise<void>}
   */
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const info = await stat(absolute);
      const dot = entry.name.lastIndexOf('.');
      const extension = dot === -1 ? '' : entry.name.slice(dot);
      const kind = JSON_EXTENSIONS.has(extension)
        ? 'json'
        : JSONL_EXTENSIONS.has(extension)
          ? 'jsonl'
          : 'other';
      files.push({
        absolute,
        path: relative(rootAbs, absolute).split(sep).join('/'),
        bytes: info.size,
        kind,
      });
    }
  };
  await walk(rootAbs);
  return files;
}

// ── 修复 ──────────────────────────────────────────────────────────────────

/**
 * @typedef {object} FileReport
 * @property {string} path
 * @property {'json' | 'jsonl' | 'other'} format
 * @property {number} bytes
 * @property {'clean' | 'repaired' | 'partial' | 'failed' | 'copied'} status
 * @property {number} records 记录数（`.json` 记为 1）
 * @property {number} repairedRecords 修复后重新可解析的记录数
 * @property {number} skippedRecords 仍然无法解析、被跳过的记录数
 * @property {number} outsideOccurrences 字符串外的标记数（= 破坏语法的处数）
 * @property {number} insideOccurrences 字符串内的标记数（脱敏结果，原样保留）
 * @property {LostValue[]} lost
 * @property {boolean | null} verified 输出文件重新解析的结果
 * @property {string | null} error
 */

/**
 * 修复一份整文档 JSON。文件里没有标记时按字节复制。
 *
 * @param {SourceFile} file
 * @param {string} targetPath
 * @param {string} replacement
 * @param {boolean} dryRun
 * @returns {Promise<FileReport>}
 */
async function repairJsonFile(file, targetPath, replacement, dryRun) {
  /** @type {FileReport} */
  const report = {
    path: file.path,
    format: 'json',
    bytes: file.bytes,
    status: 'clean',
    records: 1,
    repairedRecords: 0,
    skippedRecords: 0,
    outsideOccurrences: 0,
    insideOccurrences: 0,
    lost: [],
    verified: null,
    error: null,
  };

  if (!(await fileContainsMarker(file.absolute))) {
    if (!dryRun) {
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(file.absolute, targetPath);
    }
    report.verified = true;
    return report;
  }

  const raw = await readFile(file.absolute, 'utf8');
  const result = repairText(raw, replacement);
  report.outsideOccurrences = result.outside;
  report.insideOccurrences = result.inside;

  // 标记全在字符串里：脱敏的正常结果，原样复制，不做任何改写。
  if (result.outside === 0) {
    if (!dryRun) {
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(file.absolute, targetPath);
    }
    report.verified = true;
    return report;
  }

  if (!isValidJson(result.text)) {
    report.status = 'failed';
    report.error = '替换后仍然不是合法 JSON，未写出该文件';
    return report;
  }

  if (!dryRun) {
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, result.text, 'utf8');
  }
  report.status = 'repaired';
  report.repairedRecords = 1;
  report.lost = result.lost;
  report.verified = true;
  return report;
}

/**
 * 修复一份 JSONL。逐行流式处理：坏行修好后保留，修不好就跳过并计数。
 *
 * @param {SourceFile} file
 * @param {string} targetPath
 * @param {string} replacement
 * @param {boolean} dryRun
 * @returns {Promise<FileReport>}
 */
async function repairJsonlFile(file, targetPath, replacement, dryRun) {
  /** @type {FileReport} */
  const report = {
    path: file.path,
    format: 'jsonl',
    bytes: file.bytes,
    status: 'clean',
    records: 0,
    repairedRecords: 0,
    skippedRecords: 0,
    outsideOccurrences: 0,
    insideOccurrences: 0,
    lost: [],
    verified: null,
    error: null,
  };

  if (!(await fileContainsMarker(file.absolute))) {
    report.records = await countRecords(file.absolute);
    if (!dryRun) {
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(file.absolute, targetPath);
    }
    report.verified = true;
    return report;
  }

  const temporaryPath = `${targetPath}.repairing`;
  if (!dryRun) {
    await mkdir(dirname(targetPath), { recursive: true });
  }
  const sink = dryRun
    ? new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      })
    : createWriteStream(temporaryPath, { encoding: 'utf8' });
  const input = createReadStream(file.absolute, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  let sourceLine = 0;

  try {
    for await (const line of lines) {
      sourceLine += 1;
      if (line.trim() === '') {
        report.insideOccurrences += countMarkers(line);
        sink.write('\n');
        continue;
      }
      report.records += 1;

      if (isValidJson(line)) {
        report.insideOccurrences += countMarkers(line);
        sink.write(`${line}\n`);
        continue;
      }

      const result = repairText(line, replacement, sourceLine - 1);
      report.outsideOccurrences += result.outside;
      report.insideOccurrences += result.inside;

      if (!isValidJson(result.text)) {
        report.skippedRecords += 1;
        continue;
      }
      report.repairedRecords += 1;
      report.lost.push(...result.lost);
      sink.write(`${result.text}\n`);
    }
  } finally {
    lines.close();
    sink.end();
    await finished(sink);
  }

  if (report.outsideOccurrences > 0) {
    report.status = report.skippedRecords > 0 ? 'partial' : 'repaired';
  }

  if (dryRun) {
    report.verified = report.skippedRecords === 0;
    return report;
  }

  if (report.outsideOccurrences === 0) {
    // 标记全在字符串里：脱敏的正常结果，原样复制，不做任何改写。
    await rm(temporaryPath, { force: true });
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(file.absolute, targetPath);
    report.verified = true;
    return report;
  }
  await rename(temporaryPath, targetPath);
  report.verified = true;
  return report;
}

/**
 * 把非 JSON 文件按字节复制过去，让输出目录可以当源目录的镜像用。
 *
 * @param {FileReport[]} reports
 * @param {SourceFile[]} files
 * @param {string} outAbs
 * @param {boolean} dryRun
 * @returns {Promise<void>}
 */
async function copyOtherFiles(reports, files, outAbs, dryRun) {
  for (const file of files) {
    if (file.kind !== 'other') {
      continue;
    }
    const targetPath = join(outAbs, file.path);
    assertWritableTarget(targetPath, outAbs);
    if (!dryRun) {
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(file.absolute, targetPath);
    }
    reports.push({
      path: file.path,
      format: 'other',
      bytes: file.bytes,
      status: 'copied',
      records: 0,
      repairedRecords: 0,
      skippedRecords: 0,
      outsideOccurrences: 0,
      insideOccurrences: 0,
      lost: [],
      verified: null,
      error: null,
    });
  }
}

// ── 验证 ──────────────────────────────────────────────────────────────────

/**
 * 对输出目录里的每个 JSON / JSONL 重新解析一遍。这是「修复后 100% 合法」的
 * 唯一证据来源：不信任修复过程中的任何中间判断。
 *
 * @param {FileReport[]} reports
 * @param {string} outAbs
 * @returns {Promise<{ files: number, invalid: string[], records: number }>}
 */
async function verifyOutput(reports, outAbs) {
  const files = await listFiles(outAbs);
  const byPath = new Map(reports.map((report) => [report.path, report]));
  const invalid = [];
  let totalRecords = 0;

  for (const file of files) {
    if (file.path === REPORT_JSON || file.path === REPORT_MARKDOWN || file.kind === 'other') {
      continue;
    }
    const report = byPath.get(file.path);
    if (report === undefined) {
      continue;
    }
    if (file.kind === 'json') {
      const raw = await readFile(file.absolute, 'utf8');
      if (!isValidJson(raw)) {
        invalid.push(file.path);
        report.verified = false;
      }
    } else {
      const input = createReadStream(file.absolute, { encoding: 'utf8' });
      const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
      let bad = 0;
      for await (const line of lines) {
        if (line.trim() === '') {
          continue;
        }
        totalRecords += 1;
        if (!isValidJson(line)) {
          bad += 1;
        }
      }
      if (bad > 0) {
        invalid.push(`${file.path}（${bad} 行）`);
        report.verified = false;
      }
    }
  }

  return {
    files: files.filter(
      (file) =>
        file.kind !== 'other' && file.path !== REPORT_JSON && file.path !== REPORT_MARKDOWN,
    ).length,
    invalid,
    records: totalRecords,
  };
}

// ── 报告 ──────────────────────────────────────────────────────────────────

/**
 * @param {FileReport[]} reports
 * @param {object} meta
 * @param {string} meta.root
 * @param {string} meta.out
 * @param {string} meta.numberReplacement
 * @param {boolean} meta.dryRun
 * @param {{ files: number, invalid: string[], records: number } | null} meta.verification
 * @returns {{ json: string, markdown: string }}
 */
function buildReport(reports, meta) {
  const repaired = reports.filter((report) => report.status === 'repaired' || report.status === 'partial');
  const failed = reports.filter((report) => report.status === 'failed');
  const outsideOccurrences = reports.reduce((sum, report) => sum + report.outsideOccurrences, 0);
  const insideOccurrences = reports.reduce((sum, report) => sum + report.insideOccurrences, 0);
  const skippedRecords = reports.reduce((sum, report) => sum + report.skippedRecords, 0);
  const repairedRecords = reports.reduce((sum, report) => sum + report.repairedRecords, 0);
  const sourceBytes = reports.reduce((sum, report) => sum + report.bytes, 0);

  /** @type {Map<string, number>} */
  const lostFields = new Map();
  for (const report of reports) {
    for (const entry of report.lost) {
      const key = entry.key ?? '(未知字段)';
      lostFields.set(key, (lostFields.get(key) ?? 0) + 1);
    }
  }

  const summary = {
    root: meta.root,
    out: meta.out,
    dryRun: meta.dryRun,
    numberReplacement: meta.numberReplacement,
    files: reports.length,
    sourceBytes,
    damagedFiles: repaired.length + failed.length,
    repairedFiles: repaired.length,
    failedFiles: failed.length,
    outsideOccurrences,
    insideOccurrences,
    repairedRecords,
    skippedRecords,
    verified: meta.verification,
    lostFields: [...lostFields.entries()].sort((left, right) => right[1] - left[1]),
  };

  const table = [
    '| 文件 | 格式 | 语法破坏 | 字符串内标记 | 记录 | 修复 | 跳过 |',
    '|---|---|---:|---:|---:|---:|---:|',
    ...reports
      .filter((report) => report.format !== 'other')
      .map(
        (report) =>
          `| \`${report.path}\` | ${report.format} | ${report.outsideOccurrences} | ${report.insideOccurrences} | ${report.records} | ${report.repairedRecords} | ${report.skippedRecords} |`,
      ),
  ].join('\n');

  const lostLines = reports.flatMap((report) =>
    report.lost.map(
      (entry) =>
        `| \`${report.path}\` | ${entry.line} | ${entry.key === null ? '(未知)' : `\`${entry.key}\``} | \`${entry.literal}\` |`,
    ),
  );

  const markdown = [
    '# 脱敏损坏修复报告',
    '',
    `- 源目录：\`${meta.root}\``,
    `- 输出目录：\`${meta.out}\``,
    `- 数字占位：\`${meta.numberReplacement}\``,
    meta.dryRun ? '- 模式：**dry-run（未写盘）**' : '- 模式：已写盘',
    '',
    '## 汇总',
    '',
    `- 文件 ${summary.files} 个，源体积 ${summary.sourceBytes} 字节`,
    `- 受损文件 ${summary.damagedFiles} 个（修复 ${summary.repairedFiles} · 失败 ${summary.failedFiles}）`,
    `- 语法破坏 ${summary.outsideOccurrences} 处 → 已替换为 \`${meta.numberReplacement}\``,
    `- 字符串内标记 ${summary.insideOccurrences} 处 → 原样保留`,
    `- 跳过的坏行 ${summary.skippedRecords} 行`,
    meta.verification === null
      ? '- 验证：未执行（dry-run）'
      : `- 验证：${meta.verification.files} 个文件重新解析，不合法 ${meta.verification.invalid.length} 个`,
    '',
    '## 逐文件',
    '',
    table,
    '',
    '## 永久丢失的原值',
    '',
    '占位符没有携带长度和类型，下面每一行的原值都无法还原。',
    '',
    '| 文件 | 行 | 字段 | 修复前的畸形字面量 |',
    '|---|---:|---|---|',
    ...lostLines,
    '',
    '## 字段汇总',
    '',
    '| 字段 | 丢失处数 |',
    '|---|---:|',
    ...summary.lostFields.map(([key, count]) => `| \`${key}\` | ${count} |`),
    '',
  ].join('\n');

  return { json: JSON.stringify({ summary, files: reports }, null, 2), markdown };
}

// ── 主流程 ────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.has('help')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const root = stringArg(args, 'root') ?? DEFAULT_ROOT;
  const out = stringArg(args, 'out') ?? DEFAULT_OUT;
  const dryRun = args.get('dry-run') === true;
  const replacementName = stringArg(args, 'number-replacement') ?? 'null';
  const replacement = NUMBER_REPLACEMENTS.get(replacementName);
  if (replacement === undefined) {
    throw new Error(`--number-replacement 只能是 ${[...NUMBER_REPLACEMENTS.keys()].join(' 或 ')}`);
  }

  assertSafeOutput(root, out);
  const rootAbs = resolve(root);
  const outAbs = resolve(out);

  const rootInfo = await stat(rootAbs);
  if (!rootInfo.isDirectory()) {
    throw new Error(`--root 不是目录：${rootAbs}`);
  }

  const files = await listFiles(rootAbs);
  const sourceBytes = files.reduce((sum, file) => sum + file.bytes, 0);

  if (!dryRun) {
    await mkdir(outAbs, { recursive: true });
    const filesystem = await statfs(outAbs);
    const freeBytes = filesystem.bavail * filesystem.bsize;
    const needed = Math.ceil(sourceBytes * FREE_SPACE_FACTOR);
    if (freeBytes < needed) {
      throw new Error(
        `剩余空间不足：需要约 ${needed} 字节，实际 ${freeBytes} 字节（源 ${sourceBytes} 字节 × ${FREE_SPACE_FACTOR}）`,
      );
    }
  }

  process.stdout.write(
    `源目录 ${rootAbs}\n输出 ${outAbs}\n文件 ${files.length} 个，共 ${sourceBytes} 字节\n`,
  );

  /** @type {FileReport[]} */
  const reports = [];
  for (const file of files) {
    if (file.kind === 'other') {
      continue;
    }
    const targetPath = join(outAbs, file.path);
    assertWritableTarget(targetPath, outAbs);
    const report =
      file.kind === 'json'
        ? await repairJsonFile(file, targetPath, replacement, dryRun)
        : await repairJsonlFile(file, targetPath, replacement, dryRun);
    reports.push(report);
    if (report.status === 'failed') {
      process.stderr.write(`修复失败：${report.path}（${report.error ?? ''}）\n`);
    }
  }

  await copyOtherFiles(reports, files, outAbs, dryRun);

  const verification = dryRun ? null : await verifyOutput(reports, outAbs);
  const { json, markdown } = buildReport(reports, {
    root: rootAbs,
    out: outAbs,
    numberReplacement: replacementName,
    dryRun,
    verification,
  });

  if (!dryRun) {
    await writeFile(join(outAbs, REPORT_JSON), json, 'utf8');
    await writeFile(join(outAbs, REPORT_MARKDOWN), markdown, 'utf8');
  }

  process.stdout.write(`\n${markdown}\n`);

  const failed = reports.filter((report) => report.status === 'failed');
  if (failed.length > 0) {
    process.stderr.write(`\n${failed.length} 个文件无法修复：\n`);
    for (const report of failed) {
      process.stderr.write(`  ${report.path}：${report.error ?? ''}\n`);
    }
    process.exitCode = 1;
  }
  if (verification !== null && verification.invalid.length > 0) {
    process.stderr.write(`\n${verification.invalid.length} 个文件重新解析失败：\n`);
    for (const path of verification.invalid) {
      process.stderr.write(`  ${path}\n`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});
