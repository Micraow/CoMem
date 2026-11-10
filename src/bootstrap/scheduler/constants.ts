/**
 * 调度器的常数：轮询间隔与磁盘布局名。
 *
 * 周期、保留窗口这类数字只在这里出现一次。搬动它们等于改行为（见
 * `docs/architecture.md` §10.7），所以本文件不提供「可调」入口。
 */

/**
 * 轮询间隔：30 秒。**来源未知**（架构文档没给），是经验假设。
 *
 * 依据：自动提交的判定是量级判断（阈值 150000 token / 100 条消息），30 秒的延迟相对
 * 一次对话的时长可以忽略；更短的间隔只会让每条会话每 30 秒被 `load` 一次（读整个
 * `messages.jsonl`），而没有新消息时那次读不会有任何变化。与 `CommitRunner` 的 1 秒
 * 轮询不同：那边等的是一个**已经排队**的任务（延迟直接体现为「提交跑完了没有」），
 * 这里等的是「用户不再说话」。
 */
export const DEFAULT_INTERVAL_MS = 30_000;

/**
 * `_meta/tmp/` 里临时上传的最长保留时间：24 小时（86400 秒）。
 *
 * **来源**：`auth.sessionTtlSeconds` 的默认值 86400 秒（一天），该值的文档依据是
 * 「一天是 agent 长任务跑得完」的窗口。临时上传由一次 agent 工作流产生、在
 * `addResource` 里被消费；超过一个 agent 长任务的窗口仍没有被引用，就按废弃处理。
 *
 * **为什么不直接读配置**：`auth.sessionTtlSeconds` 是登录凭据的有效期，运维为了
 * 安全把它调到 15 分钟时，不应该让正在等待引用的上传提前失效。这里只借同一个
 * 时间尺度，不建立配置耦合。
 */
export const STAGED_UPLOAD_MAX_AGE_SECONDS = 24 * 60 * 60;

/** 会话目录名（§6.5 的 `sessions/sess_xxx/`，与 `services/session.ts` 同一个布局）。 */
export const SESSIONS_DIRECTORY_NAME = 'sessions';

/** 两个作用域根（§6.3）。组空间与个人空间同构。 */
export const SCOPE_DIRECTORY_NAMES = ['user', 'group'] as const;

/** `archive_NNN/` 里记录「这次归档抽出了哪些记忆」的文件名（§6.6 的保留名）。 */
export const MEMORY_DIFF_FILE_NAME = 'memory_diff.json';
