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
