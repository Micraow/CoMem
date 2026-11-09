/**
 * 提示词默认模板的读取入口（架构文档 §18、`prompts/*.md`）。
 *
 * 默认模板随仓库发布，放在 `prompts/` 下：进版本控制、可 review、可 diff，部署时
 * 跟着代码走。**每次渲染都读文件，不做缓存**——一次 `readFileSync` 是几十微秒，
 * 而一次模型调用是秒级；缓存换来的是「改了 `.md` 要重启」和一个必须维护的失效
 * 逻辑，那正是「改一个文件要碰代码」的另一副面孔。
 *
 * ## 为什么放在 `config/`
 *
 * `services/` 被 lint 禁止 `node:fs`（架构文档 §4.2），而四条提示词的调用点
 * （`services/search.ts`、`services/summary.ts`、`services/commit/steps/memory-extract.ts`、
 * `services/commit/steps/experience-distill.ts`）
 * 不在本 wave 的文件所有权里。默认模板与 §18 的其它默认值一样，是**随仓库发布的
 * 配置资产**，读取入口放 `config/` 不需要放宽任何一层依赖规则。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ComemError } from '../domain/errors.js';
import type { PromptId } from '../domain/prompt.js';

/**
 * `prompts/` 的绝对路径。
 *
 * 从模块位置推导而不是用 `process.cwd()`：服务可能从任意工作目录启动（systemd、
 * 容器入口），而模板跟着代码走。v1 没有构建步骤（`tsx` 直接跑源码，见
 * `docs/operations.md`），所以 `src/config/` 往上两级就是仓库根。
 */
export const PROMPTS_DIRECTORY = fileURLToPath(new URL('../../prompts/', import.meta.url));

function errorCodeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }
  const code: unknown = error.code;
  return typeof code === 'string' ? code : null;
}

/**
 * 读默认模板。
 *
 * 缺文件是**部署错误**，不是「没有自定义」：静默返回空串会让模型收到一条空系统
 * 提示词，而错误只会在模型的输出质量里出现（AGENTS.md §1）。所以抛 `INTERNAL`
 * 并带上路径。
 */
export function readPromptDefault(id: PromptId): string {
  const path = join(PROMPTS_DIRECTORY, `${id}.md`);
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (errorCodeOf(error) === 'ENOENT') {
      throw new ComemError('INTERNAL', `提示词默认模板缺失：${path}`, {
        promptId: id,
        path,
        hint: '`prompts/` 目录随仓库发布；从发布包部署时确认它被一起复制。',
      });
    }
    throw error;
  }
}
