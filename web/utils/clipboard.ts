/**
 * 写剪贴板。
 *
 * 四个位置（代码片段、API Key、文件 URI、恢复命令）各自 `try { writeText } catch {}`，
 * 失败提示也各写一遍。这里只收「写」这一步，成功与失败的反馈留给调用方——文件树
 * 页用按钮文案回执，其余三处用 toast。
 */

/** 浏览器拒绝写剪贴板时的统一提示。 */
export const CLIPBOARD_DENIED_MESSAGE = '浏览器拒绝写入剪贴板，请手动选择复制。'

/**
 * 浏览器剪贴板的最小形状。
 *
 * 不写 `navigator.clipboard` 的 DOM 类型：根 `tsconfig.json` 的 `lib` 只有
 * ES2023，`tests/unit/web/*` 从根配置跟着 import 时也必须能编译。
 */
interface ClipboardLike {
  writeText(text: string): Promise<void>
}

interface GlobalWithClipboard {
  readonly navigator?: { readonly clipboard?: ClipboardLike }
}

/** 写入剪贴板；成功返回 `true`，被浏览器拒绝（非安全上下文、权限被拒）返回 `false`。 */
export async function copyToClipboard(text: string): Promise<boolean> {
  const clipboard = (globalThis as GlobalWithClipboard).navigator?.clipboard
  if (clipboard === undefined) {
    return false
  }
  try {
    await clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
