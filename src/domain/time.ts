/**
 * 时间单位换算。
 *
 * 配置里的时长按秒（`leaseSeconds` / `timeoutSeconds` / `intervalSeconds`），
 * 运行时的 `Date` / `setTimeout` 按毫秒。这个 `1000` 在 `src/` 里曾有十几份
 * 副本，改一处漏一处就是时间单位错误：租约、超时、轮询间隔会各自差三个数量级。
 *
 * 放在 `domain/` 是因为它只依赖 JS 内建，且四层都要用；`domain/` 不 import
 * 任何其它层，所以这份定义不会把 IO 带进领域层。
 */
export const MILLISECONDS_PER_SECOND = 1000;

/**
 * 一天的毫秒数。
 *
 * 配置里的保留期 / 半衰期 / 滑动窗口按「天」（`retainDays` / `halfLifeDays` /
 * `defaultDays`），换算成毫秒只此一处。三个消费者（热度衰减、请求记录裁剪、TTL
 * 清扫）此前各写一份 `24 * 60 * 60 * 1000`：改一处漏一处时，过期与衰减会按不同的
 * 一天计算，症状是「同一份配置在两条链路上给出不同答案」。
 */
export const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
