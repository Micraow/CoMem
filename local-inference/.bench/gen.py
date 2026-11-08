import sys, time, resource
sys.path.insert(0, '/home/micraow/workspace/CoMem/local-inference')
from llama_cpp import Llama
for nt in (1, 6):
    llm = Llama(model_path='models/Qwen3-Embedding-0.6B-Q8_0.gguf', n_ctx=1024, n_batch=512,
                n_threads=nt, n_gpu_layers=0, verbose=False, seed=0)
    llm("warmup")
    u0 = resource.getrusage(resource.RUSAGE_SELF).ru_utime
    t0 = time.perf_counter()
    llm("CoMem 是面向 AI agent 的上下文记忆数据库", max_tokens=32, temperature=0)
    wall = time.perf_counter()-t0
    cpu = resource.getrusage(resource.RUSAGE_SELF).ru_utime-u0
    print(f"gen n_threads={nt}: wall={wall*1000:.0f}ms cpu={cpu*1000:.0f}ms par={cpu/wall:.2f}x {32/wall:.1f} tok/s")
    llm.close()
