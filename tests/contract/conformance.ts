/**
 * 契约套件的公共部分：失败矩阵、错误形状断言、拒绝物读取。
 *
 * 这里只放**跨实现必须一致**的东西。实现特有的重试策略、请求头、供应商
 * 报文体形状都不进这个文件——它们留在各自的集成测试里。
 */

import { describe, expect, it } from 'vitest';

import {
  ComemError,
  isRetryable,
  type ComemErrorCode,
} from '../../src/domain/errors.js';

/**
 * 供应商 HTTP 状态码 → 领域错误码的完整表（架构文档 §19）。
 *
 * 这张表被生成、嵌入、重排三条链路共用。任何一个实现在同一行给出不同的 code，
 * 契约套件都会红。
 */
export interface StatusCase {
  readonly status: number;
  readonly code: ComemErrorCode;
  readonly retryable: boolean;
}

export const PROVIDER_STATUS_CASES: readonly StatusCase[] = [
  { status: 400, code: 'INVALID_ARGUMENT', retryable: false },
  { status: 401, code: 'UNAUTHENTICATED', retryable: false },
  { status: 403, code: 'UNAUTHENTICATED', retryable: false },
  { status: 404, code: 'INVALID_ARGUMENT', retryable: false },
  { status: 413, code: 'INVALID_ARGUMENT', retryable: false },
  { status: 422, code: 'INVALID_ARGUMENT', retryable: false },
  { status: 429, code: 'RESOURCE_EXHAUSTED', retryable: true },
  { status: 500, code: 'PROVIDER_UNAVAILABLE', retryable: true },
  { status: 502, code: 'PROVIDER_UNAVAILABLE', retryable: true },
  { status: 503, code: 'PROVIDER_UNAVAILABLE', retryable: true },
  { status: 504, code: 'PROVIDER_UNAVAILABLE', retryable: true },
];

/** 一次供应商调用的失败形态。测试替身与真实适配器用同一组取值。 */
export type ProviderFailure =
  | { readonly kind: 'status'; readonly status: number }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'network' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'comem' };

/** `ProviderFailure.kind === 'comem'` 时抛出的错误消息。 */
export const PASS_THROUGH_MESSAGE = '已有领域失败。';

/** 超时用例实际生效的预算：契约要求 `details.timeoutMs` 报告这个值。 */
export const TIMEOUT_BUDGET_MS = 5;

export interface ExpectedComemFailure {
  readonly code: ComemErrorCode;
  readonly retryable: boolean;
  readonly statusCode?: number;
  /** 默认 true：领域错误消息是给用户看的中文完整句子。 */
  readonly endsWithPeriod?: boolean;
}

/**
 * 读取一次「预期失败的调用」的抛出物。
 *
 * 调用成功时直接让测试失败：契约用例的前提是这次调用必须失败。
 */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('预期调用失败，但它成功了。');
}

function expectUserFacingMessage(error: ComemError, endsWithPeriod: boolean): void {
  expect(error.message.length).toBeGreaterThan(0);
  expect(error.message).not.toContain('\n');
  expect(error.message).not.toContain('[object Object]');
  expect(error.message).not.toContain('undefined');
  expect(error.message).not.toContain('NaN');
  if (endsWithPeriod) {
    expect(error.message.endsWith('。')).toBe(true);
  }
}

/**
 * 断言抛出物是领域错误，且 code / 可重试结论 / 消息形状与期望一致。
 *
 * `message` 的形状是对外契约的一部分：错误码决定调用方分支，消息决定人能不能
 * 看懂。把 `undefined`、`[object Object]` 或一个原始 JS 异常名泄漏进去，用户就
 * 只能去读堆栈。
 */
export function expectComemFailure(
  caught: unknown,
  expected: ExpectedComemFailure,
): ComemError {
  expect(caught).toBeInstanceOf(ComemError);
  const error = caught as ComemError;
  expect(error.name).toBe('ComemError');
  expect(error.code).toBe(expected.code);
  expect(isRetryable(error)).toBe(expected.retryable);
  expectUserFacingMessage(error, expected.endsWithPeriod ?? true);
  if (expected.statusCode !== undefined) {
    expect(error.details?.['statusCode']).toBe(expected.statusCode);
  }
  return error;
}

/**
 * 供应商错误映射的共享用例。
 *
 * 只适用于**会与供应商传输层打交道**的实现。测试替身（`FakeLlmProvider`）按设计
 * 不映射传输错误，由各自的契约分组覆盖它能表达的部分；关闭态桩没有传输层。
 *
 * 实现需要遵守的约定：`fail({ kind: 'timeout' })` 用
 * `{ timeoutMs: TIMEOUT_BUDGET_MS }` 调用，且构造时配置的超时预算不小于它。
 */
export interface ProviderFailureSubject {
  readonly name: string;
  /** 触发一次必然失败的调用，并以该失败 reject。 */
  readonly fail: (failure: ProviderFailure) => Promise<unknown>;
}

export function describeProviderFailureMapping(subject: ProviderFailureSubject): void {
  describe(`供应商错误映射契约（${subject.name}）`, () => {
    for (const testCase of PROVIDER_STATUS_CASES) {
      it(`HTTP ${String(testCase.status)} → ${testCase.code}`, async () => {
        const caught = await rejection(subject.fail({ kind: 'status', status: testCase.status }));

        expectComemFailure(caught, {
          code: testCase.code,
          retryable: testCase.retryable,
          statusCode: testCase.status,
        });
      });
    }

    it('超时 → PROVIDER_UNAVAILABLE，details.timeoutMs 是实际生效预算', async () => {
      const caught = await rejection(subject.fail({ kind: 'timeout' }));
      const error = expectComemFailure(caught, {
        code: 'PROVIDER_UNAVAILABLE',
        retryable: true,
      });

      expect(error.message).toContain('超时');
      expect(error.details?.['timeoutMs']).toBe(TIMEOUT_BUDGET_MS);
    });

    it('网络不可达（TypeError）→ PROVIDER_UNAVAILABLE', async () => {
      const caught = await rejection(subject.fail({ kind: 'network' }));

      expectComemFailure(caught, { code: 'PROVIDER_UNAVAILABLE', retryable: true });
    });

    it('未知异常 → INTERNAL（不当作业务错误码）', async () => {
      const caught = await rejection(subject.fail({ kind: 'unknown' }));

      // 未知异常的兜底消息是「发生未预期的内部错误：<原始消息>」，没有句号；
      // 这里只要求它是单行、不含内部形态，不强行要求句号。
      expectComemFailure(caught, {
        code: 'INTERNAL',
        retryable: false,
        endsWithPeriod: false,
      });
    });

    it('已经是 ComemError 的失败原样透传（不重新映射）', async () => {
      const caught = await rejection(subject.fail({ kind: 'comem' }));

      const error = expectComemFailure(caught, {
        code: 'RESOURCE_EXHAUSTED',
        retryable: true,
      });
      expect(error.message).toBe(PASS_THROUGH_MESSAGE);
    });
  });
}
