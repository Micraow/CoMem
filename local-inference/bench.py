#!/usr/bin/env python3
"""本地推理服务的基准测试。

输出「设备 × 批大小 × 序列长度」的吞吐与延迟表，**贴进 README 的数字必须由它
跑出来**（AGENTS.md §6：需要系数或阈值时说清来源，实测是最硬的来源）。

三个设计决定：

1. **每个设备组合跑在子进程里。** 同一个进程里先编译 CPU 图再编译 GPU 图，两份
   权重会同时驻留内存，测出来的 `peak RSS` 是两者之和——而部署时只会跑其中一个。
   子进程也让「NPU 编译失败」这类错误只影响那一行。
2. **默认只跑小批次。** 上次有人跑 benchmark 把 16 核全占满，用户机器当场卡顿。
   默认 `--repeat 5 --batch-sizes 1,8,32 --lengths 32,128`，跑完小于一分钟；要跑
   大批次必须显式传参。
3. **限核在子进程里做。** `os.sched_setaffinity` 把进程钉在 `--threads` 个核上，
   再 `os.nice(10)`。这比在文档里写「记得加 taskset」可靠——忘了加就测出一组
   不可复现的数字。

用法：
    nice -n 10 uv run bench.py --devices cpu,gpu,npu --batch-sizes 1,8,32 --lengths 32,128
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Sequence

#: 子进程模式的内部开关。父进程用它区分「我是调度器」与「我是 worker」。
WORKER_FLAG = "--_worker"

#: 合成文本的素材。混合中英文：tokenizer 对 CJK 的切分与英文不同，只测一种语言
#: 会低估 token 数、高估吞吐。内容是「一条记忆」的样子，不是随机字节。
SAMPLE_SENTENCE = (
    "The quick brown fox jumps over the lazy dog. "
    "CoMem 是面向 AI agent 的上下文记忆数据库，语义检索依赖本地向量。"
)


@dataclass
class Measurement:
    """一个 (device, batch, length) 组合的测量结果。"""

    device: str
    batch_size: int
    target_tokens: int
    measured_tokens: float
    throughput: float
    p50_ms: float
    p95_ms: float
    samples: int


@dataclass
class ComboResult:
    """一个设备组合的全部测量。"""

    device: str
    ok: bool
    reason: str | None = None
    dimension: int | None = None
    threads: int | None = None
    baseline_rss_mb: float | None = None
    loaded_rss_mb: float | None = None
    peak_rss_mb: float | None = None
    measurements: list[Measurement] = field(default_factory=list)


def _rss_mb() -> float:
    """当前进程的常驻内存（MB）。

    读 `/proc/self/status` 而不是 `resource.getrusage`：后者只有峰值（`ru_maxrss`），
    分不出「加载模型前」与「加载模型后」。
    """
    status = Path("/proc/self/status").read_text(encoding="utf-8")
    for line in status.splitlines():
        if line.startswith("VmRSS:"):
            return int(line.split()[1]) / 1024.0
    raise RuntimeError("读不到 VmRSS")


def _peak_rss_mb() -> float:
    """进程峰值常驻内存（MB）。Linux 上 `ru_maxrss` 的单位是 KB。"""
    import resource

    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0


def _percentile(sorted_values: Sequence[float], fraction: float) -> float:
    """线性插值分位数。

    不用 `statistics.quantiles`：它在样本数小于 2 时抛异常，而 `--batch-sizes 1`
    配 `--repeat 1` 是合法的调试调用。
    """
    if not sorted_values:
        raise ValueError("空样本没有分位数")
    if len(sorted_values) == 1:
        return sorted_values[0]
    position = (len(sorted_values) - 1) * fraction
    lower = int(position)
    upper = min(lower + 1, len(sorted_values) - 1)
    weight = position - lower
    return sorted_values[lower] * (1.0 - weight) + sorted_values[upper] * weight


def _build_text(target_tokens: int) -> str:
    """拼出大约 `target_tokens` 个 token 的文本。

    按「一条句子约 30 token」估算再乘系数，**实际 token 数由后端报告**
    （`EmbeddingBatch.prompt_tokens`），表里贴的是实测值。不在这里精确对齐：不同
    tokenizer 的切分不同，精确对齐要先把后端的 tokenizer 暴露出来，而那个接口只有
    bench 用得到。
    """
    per_sentence = 30
    count = max(1, -(-target_tokens // per_sentence))
    return (SAMPLE_SENTENCE + " ") * count


def _limit_resources(threads: int) -> None:
    """限核 + 降优先级。在 worker 子进程里调用。"""
    try:
        os.nice(10)
    except OSError:
        pass
    try:
        available = sorted(os.sched_getaffinity(0))
        os.sched_setaffinity(0, set(available[:threads]))
    except (OSError, AttributeError):  # pragma: no cover - 非 Linux
        pass


def _run_combo(device: str, args: argparse.Namespace) -> ComboResult:
    """在**当前进程**里跑一个设备组合。

    调用方保证这是 worker 子进程，所以模型只加载一份。
    """
    from backends.base import BackendUnavailableError
    from backends.llama_cpp import LlamaCppEmbedding
    from server import DEFAULT_EMBEDDING_MODEL, EMBEDDING_MODEL_FILE, MODELS_DIR

    _limit_resources(args.threads)
    baseline = _rss_mb()

    model_path = args.embedding_model or str(MODELS_DIR / EMBEDDING_MODEL_FILE)
    try:
        embedding = LlamaCppEmbedding(
            model_path=model_path,
            model_id=DEFAULT_EMBEDDING_MODEL,
            device=device,  # type: ignore[arg-type]
            threads=args.threads,
            max_seq_len=args.max_seq_len,
            n_batch=args.n_batch,
        )
    except BackendUnavailableError as error:
        return ComboResult(
            device=device,
            ok=False,
            reason=str(error),
            threads=args.threads,
            baseline_rss_mb=baseline,
        )
    except Exception as error:  # noqa: BLE001 - 任何加载失败都要记进表里
        return ComboResult(
            device=device,
            ok=False,
            reason=f"{type(error).__name__}: {error}",
            threads=args.threads,
            baseline_rss_mb=baseline,
        )

    loaded = _rss_mb()
    measurements: list[Measurement] = []
    try:
        # 预热：第一次推理要编译图（oneDNN kernel / NPU blob），不进统计。
        embedding.embed(["warmup"])
        for batch_size in args.batch_sizes:
            for target_tokens in args.lengths:
                texts = [_build_text(target_tokens)] * batch_size
                # 再预热一次：批大小变化会走不同的 kernel。
                embedding.embed(texts[:1])
                latencies: list[float] = []
                measured = 0.0
                for _ in range(args.repeat):
                    start = time.perf_counter()
                    batch = embedding.embed(texts)
                    latencies.append((time.perf_counter() - start) * 1000.0)
                    measured = batch.prompt_tokens / batch_size
                latencies.sort()
                mean_ms = statistics.fmean(latencies)
                measurements.append(
                    Measurement(
                        device=device,
                        batch_size=batch_size,
                        target_tokens=target_tokens,
                        measured_tokens=measured,
                        throughput=batch_size / (mean_ms / 1000.0),
                        p50_ms=_percentile(latencies, 0.50),
                        p95_ms=_percentile(latencies, 0.95),
                        samples=len(latencies),
                    )
                )
    except Exception as error:  # noqa: BLE001 - 推理中失败同样要进表
        return ComboResult(
            device=device,
            ok=False,
            reason=f"推理失败：{type(error).__name__}: {error}",
            threads=args.threads,
            baseline_rss_mb=baseline,
            loaded_rss_mb=loaded,
            peak_rss_mb=_peak_rss_mb(),
            measurements=measurements,
        )
    finally:
        embedding.close()

    return ComboResult(
        device=device,
        ok=True,
        dimension=embedding.dimension,
        threads=args.threads,
        baseline_rss_mb=baseline,
        loaded_rss_mb=loaded,
        peak_rss_mb=_peak_rss_mb(),
        measurements=measurements,
    )


# ---------------------------------------------------------------------- 子进程调度


def _worker_main(args: argparse.Namespace) -> int:
    result = _run_combo(args.worker_device, args)
    # 只打印 JSON：父进程按行解析。日志走 stderr，不会污染。
    print(json.dumps(asdict(result), ensure_ascii=False))
    return 0


def _spawn_worker(device: str, args: argparse.Namespace) -> ComboResult:
    command = [
        sys.executable,
        str(Path(__file__).resolve()),
        WORKER_FLAG,
        "--worker-device",
        device,
        "--threads",
        str(args.threads),
        "--repeat",
        str(args.repeat),
        "--max-seq-len",
        str(args.max_seq_len),
        "--n-batch",
        str(args.n_batch),
        "--batch-sizes",
        ",".join(str(value) for value in args.batch_sizes),
        "--lengths",
        ",".join(str(value) for value in args.lengths),
    ]
    if args.embedding_model:
        command.extend(["--embedding-model", args.embedding_model])

    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        return ComboResult(
            device=device,
            ok=False,
            # 子进程崩了（段错误 / OOM）没有 JSON，把 stderr 尾巴带上来。
            reason=(
                f"子进程退出码 {completed.returncode}："
                f"{completed.stderr.strip()[-500:]}"
            ),
        )
    for line in reversed(completed.stdout.splitlines()):
        stripped = line.strip()
        if stripped.startswith("{"):
            payload = json.loads(stripped)
            return ComboResult(
                device=payload["device"],
                ok=payload["ok"],
                reason=payload.get("reason"),
                dimension=payload.get("dimension"),
                threads=payload.get("threads"),
                baseline_rss_mb=payload.get("baseline_rss_mb"),
                loaded_rss_mb=payload.get("loaded_rss_mb"),
                peak_rss_mb=payload.get("peak_rss_mb"),
                measurements=[Measurement(**item) for item in payload["measurements"]],
            )
    return ComboResult(
        device=device,
        ok=False,
        reason=f"子进程没有输出 JSON。stderr：{completed.stderr.strip()[-500:]}",
    )


# -------------------------------------------------------------------------- 输出


def _print_table(results: Sequence[ComboResult]) -> None:
    """Markdown 表格，直接能贴进 README。"""
    print()
    print(
        "| 设备 | 批大小 | 目标 token | 实测 token/条 | 吞吐（条/秒） | "
        "P50 (ms) | P95 (ms) |"
    )
    print("|---|---:|---:|---:|---:|---:|---:|")
    for combo in results:
        if not combo.ok:
            print(
                f"| {combo.device} | — | — | — | **不可用**：{combo.reason} | — | — |"
            )
            continue
        for item in combo.measurements:
            print(
                f"| {item.device} | {item.batch_size} | {item.target_tokens} | "
                f"{item.measured_tokens:.0f} | {item.throughput:.2f} | "
                f"{item.p50_ms:.1f} | {item.p95_ms:.1f} |"
            )

    print()
    print("| 设备 | 维度 | 线程 | 加载前 RSS | 加载后 RSS | 峰值 RSS |")
    print("|---|---:|---:|---:|---:|---:|")

    def _fmt(value: float | None) -> str:
        return "—" if value is None else f"{value:.0f} MB"

    for combo in results:
        print(
            f"| {combo.device} | "
            f"{combo.dimension if combo.dimension is not None else '—'} | "
            f"{combo.threads if combo.threads is not None else '—'} | "
            f"{_fmt(combo.baseline_rss_mb)} | {_fmt(combo.loaded_rss_mb)} | "
            f"{_fmt(combo.peak_rss_mb)} |"
        )


def _parse_csv(value: str, cast: type) -> list:
    return [cast(item) for item in value.split(",") if item.strip() != ""]


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="CoMem 本地推理服务的基准测试（每个设备跑在子进程里）",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(WORKER_FLAG, action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--worker-device", default="", help=argparse.SUPPRESS)

    parser.add_argument("--devices", default="cpu", help="逗号分隔：cpu,gpu,npu")
    parser.add_argument(
        "--batch-sizes",
        default="1,8,32",
        help="逗号分隔。默认只跑小批次——大批次会吃满机器",
    )
    parser.add_argument(
        "--lengths", default="32,128", help="逗号分隔的输入长度（token）"
    )
    parser.add_argument(
        "--repeat", type=int, default=5, help="每个组合的测量次数（不含预热）"
    )
    parser.add_argument("--threads", type=int, default=6)
    parser.add_argument("--max-seq-len", type=int, default=8192)
    parser.add_argument(
        "--n-batch", type=int, default=8192, help="llama.cpp 的 -ub（micro batch）"
    )
    parser.add_argument("--embedding-model", default="")
    parser.add_argument("--json", default="", help="把原始结果写到这个路径")
    args = parser.parse_args(argv)

    args.batch_sizes = _parse_csv(args.batch_sizes, int)
    args.lengths = _parse_csv(args.lengths, int)
    args.devices = _parse_csv(args.devices, str)
    if args.repeat <= 0:
        parser.error("--repeat 必须是正整数")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)
    if args.worker:
        return _worker_main(args)

    results: list[ComboResult] = []
    for device in args.devices:
        print(f"测量 {device} ...", file=sys.stderr, flush=True)
        results.append(_spawn_worker(device, args))

    _print_table(results)
    if args.json:
        Path(args.json).write_text(
            json.dumps(
                [asdict(result) for result in results], ensure_ascii=False, indent=2
            ),
            encoding="utf-8",
        )
    return 0 if all(result.ok for result in results) else 1


if __name__ == "__main__":
    sys.exit(main())
