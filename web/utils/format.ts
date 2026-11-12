/**
 * 时间与数字的显示格式（页面、组件与 `utils/connectGuide.ts` 共用一份）。
 *
 * 同一个「ISO → 本地时间文本」的纯函数曾在十个位置各写一遍：`new Date()` +
 * `Number.isNaN` 守卫 + `toLocaleString('zh-CN', …)`。选项组合只有四种，区别在
 * 精度；无效值的兜底逐处保留（绝对时间回显原始字符串，相对时间是「—」）。
 */

/** 解析 ISO 时间；不可解析返回 `null`。 */
function parseTime(iso: string): Date | null {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

/** 年-月-日 时:分（本地时区）。无效值原样回显。 */
export function formatDateTime(iso: string): string {
  const date = parseTime(iso)
  if (date === null) {
    return iso
  }
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/** 年-月-日 时:分:秒（本地时区），给 `title` 用。无效值原样回显。 */
export function formatDateTimeWithSeconds(iso: string): string {
  const date = parseTime(iso)
  if (date === null) {
    return iso
  }
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

/** 月-日 时:分（本地时区）。无效值原样回显。 */
export function formatMonthDayTime(iso: string): string {
  const date = parseTime(iso)
  if (date === null) {
    return iso
  }
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** 月-日（本地时区）。无效值原样回显。 */
export function formatMonthDay(iso: string): string {
  const date = parseTime(iso)
  if (date === null) {
    return iso
  }
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * 相对时间（§16 的要求：相对时间 + `title` 给绝对时间）。
 *
 * 超过 30 天回落到日期：这时候「37 天前」不会比日期更好读，而日期还能直接比对。
 */
export function formatRelativeTime(iso: string): string {
  const time = new Date(iso).getTime()
  if (Number.isNaN(time)) {
    return '—'
  }
  const delta = Date.now() - time
  if (delta < MINUTE_MS) {
    return '刚刚'
  }
  if (delta < HOUR_MS) {
    return `${Math.floor(delta / MINUTE_MS)} 分钟前`
  }
  if (delta < DAY_MS) {
    return `${Math.floor(delta / HOUR_MS)} 小时前`
  }
  if (delta < 30 * DAY_MS) {
    return `${Math.floor(delta / DAY_MS)} 天前`
  }
  return new Date(time).toLocaleDateString('zh-CN')
}

/**
 * 千分位 + 最多一位小数。
 *
 * Token 用量是六位数，不加分隔符读不出量级；毫秒与秒到一位就够，再多是噪声。
 */
const ONE_DECIMAL = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })

/** 千分位 + 最多一位小数。 */
export function formatOneDecimal(value: number): string {
  return ONE_DECIMAL.format(value)
}

/** 毫秒 → `38ms` / `12.4s`。超过 1 秒换成秒，读起来才有「后台很慢」的直觉。 */
export function formatMilliseconds(ms: number): string {
  if (!Number.isFinite(ms)) {
    return '—'
  }
  if (ms < 1000) {
    return `${formatOneDecimal(Math.round(ms * 10) / 10)}ms`
  }
  return `${formatOneDecimal(Math.round((ms / 1000) * 10) / 10)}s`
}

const SIZE_UNITS: readonly string[] = ['KB', 'MB', 'GB']

/** 文件大小。不足 1 KB 显示字节，其余保留一位小数。 */
export function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`
  }

  let value = size / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < SIZE_UNITS.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const digits = value >= 10 ? 0 : 1
  return `${value.toFixed(digits)} ${SIZE_UNITS[unitIndex] ?? 'KB'}`
}
