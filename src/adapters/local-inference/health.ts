/**
 * 本地推理服务的健康探测（架构文档 §18.2）。
 *
 * `GET <endpoint>/health` 是就绪的唯一判据：`ready: true` 才代表模型已经加载完。
 * 连不上、超时、非 JSON 都按「没在运行」处理——状态页不该因为一次探测失败而报错。
 */

import { isRecord } from '../../domain/guards.js';

/** 单次健康探测的上限：它只读内存里的状态。 */
const PROBE_TIMEOUT_MS = 1_500;
const POLL_INTERVAL_MS = 400;

export interface HealthSnapshot {
  readonly ready: boolean;
  readonly dimension: number | null;
  readonly backend: string | null;
  readonly device: string | null;
  readonly model: string | null;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

export async function probeHealth(endpoint: string): Promise<HealthSnapshot | null> {
  try {
    const response = await fetch(`${endpoint}/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return null;
    }
    const body: unknown = await response.json();
    if (!isRecord(body)) {
      return null;
    }
    return {
      ready: body['ready'] === true,
      dimension: numberField(body, 'dimension'),
      backend: stringField(body, 'backend'),
      device: stringField(body, 'device'),
      model: stringField(body, 'model'),
    };
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 轮询到 `ready: true` 或超时；进程提前退出时立即返回 `null`。 */
export async function waitForReady(
  endpoint: string,
  timeoutMs: number,
  pid: number,
  isAlive: (pid: number) => boolean,
): Promise<HealthSnapshot | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await probeHealth(endpoint);
    if (health?.ready === true) {
      return health;
    }
    if (!isAlive(pid)) {
      return null;
    }
    await delay(POLL_INTERVAL_MS);
  }
  return null;
}
