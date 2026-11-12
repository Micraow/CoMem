/**
 * Hook 的入口骨架：stdin → 归一化 → 总预算 → handler → 宿主信封 → 退出。
 *
 * 这一段与宿主无关。三个宿主适配器（`hosts/*.mjs`）过去各自逐字复制了一份
 * `runHook` + `readJsonStdin`，差别只在报错里的宿主名。适配器的文件头写着「不 import
 * 任何其它宿主适配器」——那条规则禁止的是**宿主之间互相引用**（共用一个
 * `parseTranscript` 会让其中一个宿主静默采到 0 条消息，见 §15.5），不是禁止共用
 * `lib/`：入口骨架本来就没有宿主差异，信封与载荷解析仍然各自独立。
 *
 * `readJsonStdin` 的宿主名由调用方以 `hostLabel` 传入，不靠 import 猜——猜出来的
 * 名字一旦与当前宿主不符，诊断就会指着另一个人。
 *
 * 任何异常都写 stderr 并正常退出（退出码 0）：hook 是旁路，它挂了不能把用户的这一轮
 * 对话一起挂掉。`PreToolUse` 的拦截是**返回值**，不是抛错。
 */

import { ComemHookError } from './http.mjs';
import {
  STDIN_READ_CAP_MS,
  armHardDeadline,
  budgetForEvent,
  createDeadline,
  diagnose,
  readStdinText,
  scheduleHardExit,
} from './lifecycle.mjs';

/**
 * 造一个宿主适配器用的 `runHook`。
 *
 * @param {{
 *   hostLabel: string,
 *   normalizeEvent: (raw: unknown) => Record<string, unknown>,
 *   formatOutput: (event: Record<string, unknown>, result: object | undefined) => object | null,
 * }} adapter 宿主适配器提供的两件事：载荷归一化与返回信封（§15.5）
 */
export function createRunHook({ hostLabel, normalizeEvent, formatOutput }) {
  /**
   * 默认读 stdin：上限与总预算同源（`STDIN_READ_CAP_MS`）。
   *
   * 宿主不写也不关 stdin 时，`for await` 永远不会返回；这个上限把它变成
   * 「没有事件」（`HOOK_STDIN_TIMEOUT`），由 `runHook` 收敛成诊断 + 退出码 0。
   */
  async function readJsonStdin() {
    const raw = (await readStdinText(STDIN_READ_CAP_MS)).trim();
    if (raw === '') {
      throw new ComemHookError(`${hostLabel} hook 没有收到 stdin 载荷。`, {
        code: 'HOOK_INVALID_ARGUMENT',
      });
    }
    return JSON.parse(raw);
  }

  /**
   * 入口。异常写 stderr 并正常退出——hook 是旁路，不能打断对话。
   *
   * `read` 与 `write` 可注入，测试不启动子进程也能跑完整链路。
   *
   * @param {(event: Record<string, unknown>, context: { deadline: ReturnType<typeof createDeadline> }) => Promise<object | undefined>} handler
   * @param {{ read?: () => Promise<unknown>, write?: (line: string) => void, hardExit?: boolean }} [options]
   *   `hardExit` 只由真正的 hook 入口传：安排兜底退出（见 `lib/lifecycle.mjs`）
   */
  return async function runHook(handler, options = {}) {
    const read = options.read ?? readJsonStdin;
    // 写完再 resolve：`scheduleHardExit` 不会截断已经开始的 stdout 写入。
    const write =
      options.write ??
      ((line) =>
        new Promise((resolve) => {
          process.stdout.write(`${line}\n`, resolve);
        }));
    // 默认不强制退出：测试用注入的 read/write 在同一个进程里跑多个用例。
    // 真正的 hook 入口（`servers/*.mjs`）传 `hardExit: true`。
    const hardExit = options.hardExit ?? false;

    let event;
    try {
      event = normalizeEvent(await read());
    } catch (error) {
      await diagnose(`co-mem hook: ${error instanceof Error ? error.message : String(error)}`);
      if (hardExit) {
        scheduleHardExit();
      }
      return null;
    }

    // 总预算从进程启动算起：读 stdin 花掉的时间也从里面扣（`lib/lifecycle.mjs`）。
    const deadline = createDeadline(budgetForEvent(event));
    if (hardExit) {
      // 硬上限：handler 不返回时也要退出（见 `armHardDeadline`）。
      armHardDeadline(deadline);
    }

    try {
      const result = await handler(event, { deadline });
      const output = formatOutput(event, result);
      if (output !== null) {
        await write(JSON.stringify(output));
      }
    } catch (error) {
      // 任何内部错误：stdout 一个字节都不写（宿主按「没有输出」放行），退出码 0。
      await diagnose(
        `co-mem hook ${event.event}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (hardExit) {
      scheduleHardExit();
    }
    return event;
  };
}
