type ExperienceEvidence =
  | {
    readonly kind: 'message';
    readonly messageId: string;
    readonly role: 'user' | 'assistant';
    readonly quote: string;
  }
  | {
    readonly kind: 'case';
    readonly caseUri: string;
    readonly quote: string;
  };

interface RenderedExperience {
  readonly claim: string;
  readonly situation: readonly string[];
  readonly approach: readonly string[];
  readonly reflection: readonly string[];
  readonly evidence: readonly ExperienceEvidence[];
}

function renderEvidence(evidence: ExperienceEvidence, currentArchive: string): string {
  return evidence.kind === 'message'
    ? `- message \`${evidence.messageId}\` (${evidence.role})，archive \`${currentArchive}\`：${evidence.quote}`
    : `- case \`${evidence.caseUri}\`：${evidence.quote}`;
}

/**
 * 从旧正文取出证据行。
 *
 * 合并旧经验时，模型只负责新结论和本次新增证据；旧证据由服务端从原正文保留。
 * 否则模型每重写一次都可能丢掉先前案例，正文越“简洁”，溯源反而越少。
 */
export function historicalExperienceEvidence(content: string): readonly string[] {
  const match = /(?:^|\n)## 原文证据[ \t]*\r?\n([\s\S]*?)(?=\r?\n##[ \t]|$)/u.exec(content);
  if (match === null) return [];
  return (match[1] ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '));
}

/** 结构化归纳结果 → 给人阅读、供检索的 Markdown 正文。 */
export function renderExperienceContent(
  experience: RenderedExperience,
  historicalEvidence: readonly string[],
  currentArchive: string,
): string {
  const bullets = (items: readonly string[]) => items.map((item) => `- ${item}`).join('\n');
  const steps = experience.approach.map((item, index) => `${index + 1}. ${item}`).join('\n');
  const evidence = [...new Set([
    ...experience.evidence.map((item) => renderEvidence(item, currentArchive)),
    ...historicalEvidence,
  ])];
  return [
    // L0 摘要取正文第一行；这里必须先是完整、可独立理解的结论。
    experience.claim,
    `## 适用情境\n\n${bullets(experience.situation)}`,
    `## 做法\n\n${steps}`,
    `## 反思与边界\n\n${bullets(experience.reflection)}`,
    `## 原文证据\n\n${evidence.join('\n')}`,
  ].join('\n\n');
}
