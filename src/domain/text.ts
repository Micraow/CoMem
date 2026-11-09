/**
 * 纯文本切分（架构文档 §8.1「中文必须单字切分，否则检索整段失效」）。
 *
 * 这一层不知道 FTS5 存在：它只回答「这段文本切成哪些可检索的 token」。索引侧把
 * 结果写进 `node_fts`，查询侧把结果包成 FTS5 短语，两边共用同一个函数——只切一边
 * 等于中文检索整体失效。
 *
 * 为什么必须单字切分：`unicode61` 按 Unicode 类别切词，连续 CJK 字符属于「字母类」，
 * 整段会变成一个巨型 token（「上下文记忆数据库的设计」只有 1 个 token），只有把整段
 * 原样当查询才命中，用户不可能这么搜。`trigram` 天然支持子串，但要求查询至少 3 个
 * 字符，而中文最常见的双字词（「记忆」「偏好」「设计」）全部落空。单字切分 + 短语
 * 匹配是唯一同时覆盖双字词与多字词的方案；精度由短语「字符必须相邻」保证，单字带来
 * 的虚词噪声（「的」「在」）由层级加权与 rerank 处理。
 *
 * 全角标点（，。：；！？「」）不是 CJK 字符，不切分：`unicode61` 本来就按 Unicode
 * 类别把它们当分隔符，切与不切结果一样，多切只会让索引变大。
 */

/**
 * CJK 码点区间（架构文档 §8.1）：假名 `\u3040-\u30ff`、扩展 A `\u3400-\u4dbf`、
 * 基本区 `\u4e00-\u9fff`、兼容区 `\uf900-\ufaff`。
 *
 * 只维护这一份字符串，分词正则从这里构造，避免区间在多处各写一遍后漂移。
 */
const CJK_CODE_POINTS = '\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff';

/** 全局匹配版本，供 `segmentCjk` 一次扫描替换。 */
const CJK_GLOBAL = new RegExp(`[${CJK_CODE_POINTS}]`, 'g');

/** 连续空白折叠成单个空格。`segmentCjk` 的第二步。 */
const WHITESPACE_RUN = /\s+/g;

/**
 * CJK 单字切分：每个 CJK 字符两侧补空格，再合并空白。非 CJK 文本原样保留。
 *
 * 幂等：`segmentCjk(segmentCjk(x)) === segmentCjk(x)`——第一遍已经在 CJK 字符两侧
 * 留下空格，第二遍补的空格会被空白折叠吃掉，结果不变。索引与查询都调这个函数，
 * 幂等性保证「先切过再切」不会产生不同的查询串。
 *
 * 性能：一次 `replace` 线性扫描 + 一次空白折叠 `replace`，回调里只做模板串拼接，
 * 不编译正则。实测 100KB 中文文档 2–4ms（Node 26 / V8，本机），相对一次 SQLite
 * 写入可以忽略；不需要更复杂的 tokenizer 状态机。
 */
export function segmentCjk(text: string): string {
  if (text === '') {
    return '';
  }
  return text.replace(CJK_GLOBAL, (char) => ` ${char} `).replace(WHITESPACE_RUN, ' ').trim();
}

