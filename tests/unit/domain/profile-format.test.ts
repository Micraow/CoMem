/**
 * 画像正文格式契约校验（架构文档 §11.1）。
 *
 * 这些用例是「契约由服务端执行」的证据：每一条能由字面判定的格式规则各有一份
 * 反例。语义规则（「同一状态只留最新值」「陈述事实不写评价」）不在这里，它们只
 * 靠提示词——见 `src/domain/profile-format.ts` 的文件头。
 */

import { describe, expect, it } from 'vitest';

import { PROFILE_ENTRY_MAX_CHARS } from '../../../src/domain/memory-types/profile.js';
import {
  validateProfileBody,
  type ProfileViolation,
  type ProfileViolationKind,
} from '../../../src/domain/profile-format.js';

/** 只留 kind / line，断言时不受将来新增字段（如长度计数）影响。 */
function simplified(violations: readonly ProfileViolation[]): { kind: ProfileViolationKind; line: number }[] {
  return violations.map((violation) => ({ kind: violation.kind, line: violation.line }));
}

describe('validateProfileBody', () => {
  it('合规画像零违规（`- ` 与 `* ` 两种 bullet 都接受）', () => {
    const body = [
      '- 后端工程师，做分布式存储 (as of 2026-11-09)',
      '* 常住上海，籍贯杭州 (as of 2026-11-09)',
      '',
    ].join('\r\n');

    expect(validateProfileBody(body)).toEqual([]);
  });

  it('全角括号的日期后缀同样合规（中文输入法与中文写作的模型常给出这种形态）', () => {
    const body = [
      '- 后端工程师，做分布式存储（as of 2026-11-09）',
      '- 常住上海 (as of 2026-11-09）',
      '',
    ].join('\n');

    expect(validateProfileBody(body)).toEqual([]);
  });

  it('Markdown 标题行报 heading', () => {
    const body = ['# 用户画像', '- 后端工程师 (as of 2026-11-09)'].join('\n');

    expect(simplified(validateProfileBody(body))).toEqual([{ kind: 'heading', line: 1 }]);
  });

  it('代码块围栏报 code-fence', () => {
    expect(simplified(validateProfileBody('```'))).toEqual([{ kind: 'code-fence', line: 1 }]);
  });

  it('非空行不是 bullet 报 not-bullet', () => {
    expect(simplified(validateProfileBody('这是一段散文，不是条目。'))).toEqual([
      { kind: 'not-bullet', line: 1 },
    ]);
  });

  it('bullet 结尾缺少日期后缀报 missing-date-suffix', () => {
    expect(simplified(validateProfileBody('- 后端工程师'))).toEqual([
      { kind: 'missing-date-suffix', line: 1 },
    ]);
  });

  it('日期后缀存在但不可解析 / 超出合理年份报 invalid-date-suffix', () => {
    expect(
      simplified(
        validateProfileBody(
          [
            // Date.parse 能把 2 月 30 日归一化成 3 月 2 日：形状合法但不是真实日期。
            '- 后端工程师 (as of 2026-02-30)',
            // 月份越界，Date.parse 返回 NaN。
            '- 住在上海 (as of 2026-13-01)',
            // 年份早于归档格式存在的年代。
            '- 养了一只猫 (as of 1999-12-31)',
            // 缺前导零，不是契约写的 YYYY-MM-DD。
            '- 用 TypeScript (as of 26-11-09)',
          ].join('\n'),
        ),
      ),
    ).toEqual([
      { kind: 'invalid-date-suffix', line: 1 },
      { kind: 'invalid-date-suffix', line: 2 },
      { kind: 'invalid-date-suffix', line: 3 },
      { kind: 'invalid-date-suffix', line: 4 },
    ]);
  });

  it('单条正文超过上限报 entry-too-long，日期后缀不计入长度', () => {
    const exactlyMax = '- ' + '甲'.repeat(PROFILE_ENTRY_MAX_CHARS) + ' (as of 2026-11-09)';
    const oneOver = '- ' + '甲'.repeat(PROFILE_ENTRY_MAX_CHARS + 1) + ' (as of 2026-11-09)';

    expect(validateProfileBody(exactlyMax)).toEqual([]);
    expect(simplified(validateProfileBody(oneOver))).toEqual([
      { kind: 'entry-too-long', line: 1 },
    ]);
  });

  it('按 Unicode 码点数计数，emoji 算一个字符', () => {
    const body = '- ' + '😀'.repeat(PROFILE_ENTRY_MAX_CHARS) + ' (as of 2026-11-09)';

    expect(validateProfileBody(body)).toEqual([]);
  });

  it('复合场景：合规 bullet 与违规行混排，只报违规行', () => {
    const body = [
      '- 后端工程师 (as of 2026-11-09)',
      '# 小标题',
      '- 用户住在上海 (as of 2026-02-30)',
      '这是一段散文。',
      '- ' + '甲'.repeat(PROFILE_ENTRY_MAX_CHARS + 1) + ' (as of 2026-11-09)',
      '- 用户喜欢猫',
    ].join('\n');

    expect(simplified(validateProfileBody(body))).toEqual([
      { kind: 'heading', line: 2 },
      { kind: 'invalid-date-suffix', line: 3 },
      { kind: 'not-bullet', line: 4 },
      { kind: 'entry-too-long', line: 5 },
      { kind: 'missing-date-suffix', line: 6 },
    ]);
  });

  it('标题与围栏不再重复报 not-bullet（一次缺陷算一次）', () => {
    expect(simplified(validateProfileBody('# 标题'))).toEqual([{ kind: 'heading', line: 1 }]);
    expect(simplified(validateProfileBody('```'))).toEqual([{ kind: 'code-fence', line: 1 }]);
  });

  it('空正文不算格式违规（没有可判定的行）', () => {
    expect(validateProfileBody('')).toEqual([]);
    expect(validateProfileBody('\n \n')).toEqual([]);
  });
});
