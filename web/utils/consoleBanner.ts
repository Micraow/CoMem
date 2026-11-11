/**
 * 单用户模式横幅（架构文档 §16 的身份引导、§12.7 的认证开关）。
 *
 * 默认配置（`auth.enabled: false`）下服务端把不带凭据的请求当成
 * `server.subject`，任何能访问这个端口的人都是同一个用户。界面上曾经没有任何
 * 地方说明这件事：头像显示 `L`、导航可用、写入成功，读起来像一个正常的多用户
 * 部署。这条横幅回答三个问题——现在有没有认证、别人会不会也是他、要怎么做。
 *
 * 做成常驻横幅而不是 toast：toast 会消失，消失之后用户又回到「不知道」的状态。
 * 文案单独放在这里，是为了能用普通替身测「`authEnabled` 为 false 时出现、为
 * true 时消失」，而不是为一条模板分支装整个组件运行时。
 *
 * 主体名只用于这句话里的用户 ID（`user:local` → `local`）。`authEnabled` 缺省
 * 与 `false` 同义：`fetchConsoleIdentity` 从 `/health` 解出的身份不带这个字段，
 * 那正是单用户模式。
 */
import type { ConsoleIdentity } from '../composables/consoleIdentity'

/** 横幅文案；`null` 表示不显示（已登录或已打开多用户认证）。 */
export function singleUserModeNotice(identity: ConsoleIdentity | null): string | null {
  if (identity === null || identity.authEnabled === true) {
    return null
  }

  const subject = identity.subject
  const userId = subject.startsWith('user:') ? subject.slice('user:'.length) : subject
  return `单用户模式：没有登录。任何能访问这个服务端口的人，操作的都是同一个用户 ${userId}。要区分用户，请在配置里启用多用户登录。`
}
