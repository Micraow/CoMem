/**
 * 提示词用例（架构文档 §9.2、§11.3、§11.4、§18）。
 *
 * ## 两层存储，一个优先级
 *
 * | 层 | 位置 | 谁改 |
 * |---|---|---|
 * | 默认 | 仓库里的 `prompts/*.md`（进版本控制，可 review、可 diff） | 改代码 |
 * | 覆盖 | SQLite 的 `prompt_override` 表 | 控制台 |
 *
 * 优先级：**默认 < 覆盖**。恢复默认 = 删掉覆盖行。不让服务端直接改仓库文件，是
 * 因为容器只读挂载、多副本部署、`git status` 污染这三个场景下，「改仓库文件」都
 * 不成立。
 *
 * ## 版本漂移
 *
 * 保存覆盖时记下当时默认模板的摘要（`base_digest`）。换版本后默认值变了，摘要就
 * 对不上，`stale` 为真——控制台据此显示「默认值已更新」，而不是让覆盖**静默盖住**
 * 新的默认值。用户看到的证据只有「模型表现变了」，那时已经无法归因。
 *
 * ## 为什么默认模板不缓存
 *
 * 每次渲染读一次 `prompts/*.md`（几十微秒），换来的是「改 `.md` 下一次请求就生效」
 * 和一套不需要维护的失效逻辑。缓存会把一个可以直接看见的行为变成「要重启」。
 */

import { readPromptDefault } from '../config/prompt-defaults.js';
import { stableDigest } from '../domain/node.js';
import {
  PROMPT_IDS,
  normalizePromptBody,
  promptDefinition,
  renderPromptBody,
  validatePromptBody,
  type PromptId,
  type PromptVariable,
} from '../domain/prompt.js';
import type { PromptOverrideRow, PromptRepository } from '../adapters/sqlite/prompt-repository.js';

import { notifyPromptRenderers } from './prompts/registry.js';

/** 列表行：不含正文。控制台列表不需要为六条提示词各读一遍模板。 */
export interface PromptSummary {
  readonly id: PromptId;
  readonly description: string;
  readonly variables: readonly PromptVariable[];
  /** 是否被数据库覆盖 */
  readonly overridden: boolean;
  /**
   * 覆盖基于的默认模板已经不是当前默认模板。
   *
   * 含义是「你的覆盖建立在一个旧版本的默认值上」：仓库改过这条提示词，而你的
   * 覆盖会把它整篇盖掉。**只在 `overridden` 为真时有意义**。
   */
  readonly stale: boolean;
  /** 覆盖的最后修改时间；没有覆盖时为 `null`。 */
  readonly updatedAt: string | null;
}

/** 详情：列表行的全部字段 + 当前生效正文 + 仓库默认正文（控制台对比用）。 */
export interface PromptDetail extends PromptSummary {
  /** 当前生效的正文（覆盖优先） */
  readonly body: string;
  /** 仓库里的默认正文 */
  readonly defaultBody: string;
}

export interface PromptServiceDeps {
  readonly overrides: PromptRepository;
}

function summaryOf(detail: PromptDetail): PromptSummary {
  return {
    id: detail.id,
    description: detail.description,
    variables: detail.variables,
    overridden: detail.overridden,
    stale: detail.stale,
    updatedAt: detail.updatedAt,
  };
}

export class PromptService {
  readonly #store: PromptRepository;
  readonly #overrides: Map<PromptId, PromptOverrideRow>;

  /**
   * 启动时把全部覆盖读进内存，并**逐条校验**。
   *
   * 校验放在构造期而不是第一次渲染：一条引用了不存在变量的覆盖会让那一次模型调用
   * 失败，而失败信息只会出现在后台任务里。启动即失败，错误能定位到具体提示词与
   * 变量（AGENTS.md §1）。
   */
  constructor(deps: PromptServiceDeps) {
    this.#store = deps.overrides;
    this.#overrides = new Map();
    for (const id of PROMPT_IDS) {
      readPromptDefault(id);
    }
    for (const row of deps.overrides.list()) {
      validatePromptBody(row.promptId, row.body);
      this.#overrides.set(row.promptId, row);
    }
  }

  list(): readonly PromptSummary[] {
    return PROMPT_IDS.map((id) => summaryOf(this.get(id)));
  }

  get(id: PromptId): PromptDetail {
    const definition = promptDefinition(id);
    const defaultBody = normalizePromptBody(readPromptDefault(id));
    const override = this.#overrides.get(id);
    return {
      id,
      description: definition.description,
      variables: definition.variables,
      overridden: override !== undefined,
      stale: override !== undefined && override.baseDigest !== stableDigest(defaultBody),
      updatedAt: override?.updatedAt ?? null,
      body: override?.body ?? defaultBody,
      defaultBody,
    };
  }

  /**
   * 保存覆盖。保存前校验：语法合法，且模板里的变量都在定义里。
   *
   * 不做「缺变量就拒绝」的检查：模板少用一个变量是合法的编辑（比如不想把预取到的
   * 已读记忆发给模型），**缺值**才是错误，而那只可能发生在渲染时。
   */
  save(id: PromptId, body: string): PromptDetail {
    const normalized = normalizePromptBody(body);
    validatePromptBody(id, normalized);
    const row: PromptOverrideRow = {
      promptId: id,
      body: normalized,
      baseDigest: stableDigest(normalizePromptBody(readPromptDefault(id))),
      updatedAt: new Date().toISOString(),
    };
    this.#store.upsert(row);
    this.#overrides.set(id, row);
    notifyPromptRenderers();
    return this.get(id);
  }

  /** 删掉覆盖，回到仓库默认值。删一条不存在的覆盖不是错误（幂等）。 */
  reset(id: PromptId): PromptDetail {
    this.#store.delete(id);
    this.#overrides.delete(id);
    notifyPromptRenderers();
    return this.get(id);
  }

  /**
   * 渲染。
   *
   * 变量缺失、模板语法错误、引用了不存在的变量都抛 `INVALID_ARGUMENT`——渲染出
   * `{{pages}}` 字面量时，错误只会在模型的输出里出现。
   */
  render(id: PromptId, variables: Readonly<Record<string, string>>): string {
    return renderPromptBody(id, this.#bodyOf(id), variables);
  }

  /**
   * 预览：没传的变量用「〔说明〕」占位。
   *
   * 预览要能回答「这一截会被替换成什么」，所以占位符里放的是**中文说明**而不是
   * 变量名（AGENTS.md §11：内部标识不进用户可见区域）。
   */
  preview(id: PromptId, variables: Readonly<Record<string, string>>): string {
    const filled: Record<string, string> = {};
    for (const variable of promptDefinition(id).variables) {
      filled[variable.name] = variables[variable.name] ?? `〔${variable.description}〕`;
    }
    return this.render(id, filled);
  }

  #bodyOf(id: PromptId): string {
    return this.#overrides.get(id)?.body ?? normalizePromptBody(readPromptDefault(id));
  }
}
