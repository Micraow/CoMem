/**
 * 本地推理的状态描述（架构文档 §18.2）。
 *
 * 这里只有纯函数：判断仓库里缺什么、把缺失项翻译成可复制的安装命令、把配置里的
 * `baseUrl` 归一成健康探测的源地址。进程管理在 `manager.ts`，pid 在 `pid-file.ts`。
 *
 * **命令写死在这里。** 安装命令与启动命令不接受任何请求参数；缺失项只是筛选
 * 已经固定的步骤，不是拼接用户输入。
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 没有配置 `providers.embedding.baseUrl` 时探测的地址。 */
const DEFAULT_ENDPOINT = 'http://127.0.0.1:8089';

/** `local-inference/` 的目录名；仓库根由装配层推导。 */
export const LOCAL_INFERENCE_DIRECTORY = 'local-inference';

const EMBEDDING_MODEL_FILE = 'Qwen3-Embedding-0.6B-Q8_0.gguf';
const RERANK_MODEL_FILE = 'qwen3-reranker-0.6b-q8_0.gguf';
const MODELSCOPE = 'https://www.modelscope.cn/models';

/** `missing` 的取值。顺序即设置页的展示顺序。 */
export type LocalInferenceMissing = 'venv' | 'server' | 'embedding-model' | 'rerank-model';

const MISSING_LABELS: Readonly<Record<LocalInferenceMissing, string>> = {
  venv: 'Python 运行环境',
  server: '服务程序',
  'embedding-model': '向量模型',
  'rerank-model': '重排模型',
};

/** 缺失项的中文名。错误消息与设置页共用，避免两处各翻一套。 */
export function missingLabelOf(item: LocalInferenceMissing): string {
  return MISSING_LABELS[item];
}

export interface LocalInferenceStatus {
  readonly available: boolean;
  readonly running: boolean;
  readonly endpoint: string;
  readonly dimension: number | null;
  readonly backend: string | null;
  readonly device: string | null;
  readonly model: string | null;
  readonly missing: readonly LocalInferenceMissing[];
  /** 不可用时给一段「补齐依赖并启动」的命令；可用时为 `null`。 */
  readonly startCommand: string | null;
}

export interface LocalInferenceStartResult {
  readonly started: true;
  readonly ready: true;
  readonly endpoint: string;
  readonly dimension: number | null;
}

/** `providers.embedding.baseUrl` → 健康探测的源地址；不是合法 URL 就用默认。 */
export function endpointOf(baseUrl: string): string {
  if (baseUrl.trim() === '') {
    return DEFAULT_ENDPOINT;
  }
  try {
    return new URL(baseUrl).origin;
  } catch {
    return DEFAULT_ENDPOINT;
  }
}

/** 本机缺哪些依赖。`rerank-model` 不影响启动，只影响重排。 */
export function missingOf(directory: string): LocalInferenceMissing[] {
  const missing: LocalInferenceMissing[] = [];
  if (!existsSync(join(directory, '.venv', 'bin', 'python'))) {
    missing.push('venv');
  }
  if (!existsSync(join(directory, 'server.py'))) {
    missing.push('server');
  }
  const models = modelFiles(directory);
  if (!models.some((name) => name.includes('embedding'))) {
    missing.push('embedding-model');
  }
  if (!models.some((name) => name.includes('rerank'))) {
    missing.push('rerank-model');
  }
  return missing;
}

/**
 * 不可用时展示的命令。
 *
 * 只有这里知道依赖装在哪、模型叫什么；让用户照着文档自己拼四段命令，「本机不可用」
 * 就仍然要靠终端。命令按缺失项生成，已经装好的步骤不会重复出现。
 */
export function installCommandOf(missing: readonly LocalInferenceMissing[]): string {
  const lines = [`cd ${LOCAL_INFERENCE_DIRECTORY}`];
  if (missing.includes('venv')) {
    lines.push(
      'uv python install 3.12',
      'uv venv --python 3.12 .venv',
      'uv pip install --python .venv/bin/python fastapi "uvicorn[standard]" pydantic llama-cpp-python',
    );
  }
  if (missing.includes('embedding-model')) {
    lines.push(
      `curl -L -C - -o models/${EMBEDDING_MODEL_FILE} "${MODELSCOPE}/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/master/${EMBEDDING_MODEL_FILE}"`,
    );
  }
  if (missing.includes('rerank-model')) {
    lines.push(
      `curl -L -C - -o models/${RERANK_MODEL_FILE} "${MODELSCOPE}/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/resolve/master/${RERANK_MODEL_FILE}"`,
    );
  }
  if (missing.includes('server')) {
    lines.push(`# ${LOCAL_INFERENCE_DIRECTORY}/server.py 缺失：从仓库恢复整个目录`);
  }
  lines.push('nice -n 10 taskset -c 0-5 .venv/bin/python server.py --device cpu --threads 6');
  return lines.join('\n');
}

function modelFiles(directory: string): readonly string[] {
  try {
    return readdirSync(join(directory, 'models'))
      .map((name) => name.toLowerCase())
      .filter((name) => name.endsWith('.gguf'));
  } catch {
    return [];
  }
}
