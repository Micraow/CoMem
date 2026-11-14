/**
 * 配置交叉校验（架构文档 §18、§12.7）。
 *
 * 从 `schema.ts` 的 `transform` 搬出来：那个文件已经到形状门禁的上限，而交叉校验
 * 是「启动期拒绝自相矛盾的配置」这一组规则的天然归属，单独成文件后才能继续加。
 *
 * 为什么是 `transform` 而不是 `superRefine`：`config/index.ts` 的 `validate()` 只按
 * issue 的 `code` 生成消息（`describeIssue`），自定义 refine 的 `message` 会被丢掉；
 * 下面几条都要求完整的可操作说明。`ComemError` 不是 `ZodError`，`safeParse` 会原样
 * 抛出。
 */

import { ComemError } from '../domain/errors.js';
import { isLoopbackAddress } from '../domain/network.js';

import type { ComemConfig } from './schema.js';
import { llmConfigured } from './readiness.js';

/**
 * 回环信任不允许与非回环监听组合（§12.7）。
 *
 * `auth.trustLoopback: true` 时，**任何**不带凭据的回环请求都被认证成
 * `server.subject`。默认的 `127.0.0.1` 只把这件事限制在本机；写成 `0.0.0.0` /
 * `::` 之后，任何能访问端口的人都是同一个用户——区别只在于 NAT / 代理后的来源
 * 地址不再被 Node 报成回环，于是「配了不生效」比「配了生效」更常见。这一项在
 * 启动期失败，不留给第一次请求发现。
 *
 * `0.0.0.0` / `::` 算**非回环**：它们监听所有接口，不是「只在本机」。
 */
function assertTrustLoopbackHostIsLoopback(config: ComemConfig): void {
  if (!config.auth.trustLoopback || isLoopbackAddress(config.server.host)) {
    return;
  }
  throw new ComemError(
    'INVALID_ARGUMENT',
    `auth.trustLoopback 是 true 时 server.host 必须是回环地址（127.0.0.1 / ::1 / localhost），当前是 ${config.server.host}。回环信任把不带凭据的本机请求当成 server.subject（${config.server.subject}），非回环监听会让任何能连上端口的人都成为这个用户。要对外监听必须关掉它：

auth:
  trustLoopback: false

（或把 server.host 改回 127.0.0.1，只允许本机访问。）`,
    {
      field: 'auth.trustLoopback',
      host: config.server.host,
      trustLoopback: config.auth.trustLoopback,
    },
  );
}

/**
 * 校验一组**必须同时成立**的配置组合。
 *
 * 顺序是有意的：先挡「回环信任 + 监听所有接口」——它让任何一个能连上端口的人拿到
 * 绑定主体的全部权限，比其它几条配置错误严重一个量级；其余几条只影响某条功能是否
 * 真的按配置生效。
 */
export function assertCrossChecks(config: ComemConfig): void {
  assertTrustLoopbackHostIsLoopback(config);

  /**
   * 交叉校验：开了重排就必须有重排供应商。
   *
   * **不能静默降级成「不重排」。** 用户把 `retrieval.rerank.enabled` 打开，是因为
   * 他认为召回噪声需要模型压一压；退回融合分排序会给出「看起来能用、实际没按配置
   * 生效」的结果。这类错误在启动时抛，比在「为什么检索质量没变」的排查里发现好。
   */
  if (config.retrieval.rerank.enabled && config.providers.rerank.type === 'disabled') {
    throw new ComemError(
      'INVALID_ARGUMENT',
      'retrieval.rerank.enabled 需要 providers.rerank：开启重排时必须配置重排供应商，否则重排不会发生。',
      {
        rerankType: config.providers.rerank.type,
        field: 'providers.rerank',
      },
    );
  }

  /**
   * 交叉校验：开了记忆合并就必须有真的模型。
   *
   * 规则生成器（`summary.generator: rule`）产不出操作列表——它的存在是为了让没有
   * 模型凭据的部署（以及不需要模型的测试）仍能生成摘要。开着合并却用它，端点的
   * 每一次调用都会停在模型之前，看起来像「没有可合并的记忆」而实际是配置没生效。
   * `providers.llm.default.type: disabled` 是同一个判据的另一种写法：两者都表示
   * 「没有可用的模型」。这种错误在启动时抛，比在第一次合并时发现好。
   */
  const llmEnabled = llmConfigured(config);
  if (
    config.memory.consolidation.enabled &&
    (config.summary.generator !== 'llm' || !llmEnabled)
  ) {
    throw new ComemError(
      'INVALID_ARGUMENT',
      'memory.consolidation.enabled 需要可用的 LLM：summary.generator 必须是 llm，且 providers.llm.default 需要配置真实的供应商地址。',
      {
        field: 'memory.consolidation.enabled',
        summaryGenerator: config.summary.generator,
        llmType: config.providers.llm.default.type,
      },
    );
  }

  /**
   * 交叉校验：开了工作记忆就必须有真的模型。
   *
   * **这里和 `ingest` 的判据不同，不能降级。** 导入的阶段一（归档 + 建任务 +
   * 游标）不依赖模型，跳过后面的阶段二仍然留下「会话已经进库」这个独立产物；工作
   * 记忆没有对应的「一半」——它在 `archive_summary` 步骤里，前面是规则生成器也能
   * 做的目录摘要，后面只有工作记忆本身。开了它却没有模型，这一步就只剩「跳过一个
   * 空步骤」，配置项等于在撒谎。所以启动时失败，而不是每次归档都投递一个注定失败
   * 的任务。
   */
  if (config.memory.workingMemory.enabled && !llmEnabled) {
    throw new ComemError(
      'INVALID_ARGUMENT',
      'memory.workingMemory.enabled 需要可用的 LLM：工作记忆没有规则生成器。配置真实的 providers.llm.default 供应商地址，或关闭工作记忆。',
      {
        field: 'memory.workingMemory.enabled',
        llmType: config.providers.llm.default.type,
      },
    );
  }

  /**
   * 交叉校验：摘要生成器是 `llm` 就必须有可用的 LLM 提供者。
   *
   * 默认生成器是 `llm`，而 `providers.llm.default.type` 的占位默认值指不到任何
   * 真实网关。没有模型凭据的部署（本地开发、CI、只用规则摘要）必须能把 LLM 显式
   * 关掉——但「关掉」与「摘要仍然走 llm」互相矛盾，此时每一次摘要都会停在模型
   * 之前。让它在启动时失败，而不是每次写文件都投递一次注定失败的摘要失效。
   */
  if (config.summary.generator === 'llm' && config.providers.llm.default.type === 'disabled') {
    throw new ComemError(
      'INVALID_ARGUMENT',
      'summary.generator 是 llm 但没有可用的 LLM 提供者：providers.llm.default.type 是 disabled。把 summary.generator 改成 rule，或配置 providers.llm。',
      {
        field: 'providers.llm.default',
        summaryGenerator: config.summary.generator,
        llmType: config.providers.llm.default.type,
      },
    );
  }
}
