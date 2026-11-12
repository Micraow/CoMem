/**
 * 服务端连不上时的兜底提示。
 *
 * API 客户端、登录页、初始化页各写过一遍：三处对异常类型的处理不同（`ApiClientError`
 * 取原句、`ConsoleIdentityError` 取原句、`ConsoleBootstrapError` 走错误码文案），
 * 不能合成同一个 `errorMessageOf`；同一句提示只留一份。
 */
export const SERVICE_UNREACHABLE_MESSAGE = '无法连接 CoMem 服务，请确认后端已启动。'
