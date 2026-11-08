import sys, time, resource
sys.path.insert(0, '/home/micraow/workspace/CoMem/local-inference')
import llama_cpp
from llama_cpp import Llama, LLAMA_POOLING_TYPE_LAST
text = "The quick brown fox jumps over the lazy dog. CoMem 是面向 AI agent 的上下文记忆数据库。" * 8
for ub in (None, 2048):
    kw = {"n_ubatch": ub} if ub else {}
    llm = Llama(model_path='models/Qwen3-Embedding-0.6B-Q8_0.gguf', embedding=True,
                n_ctx=8192, n_batch=8192, n_threads=6, n_threads_batch=6, n_gpu_layers=0,
                pooling_type=LLAMA_POOLING_TYPE_LAST, verbose=False, seed=0, **kw)
    print(f"ub={ub} llama_n_ubatch={llama_cpp.llama_n_ubatch(llm._ctx.ctx)} llama_n_batch={llama_cpp.llama_n_batch(llm._ctx.ctx)}")
    llm.create_embedding([text])
    u0=resource.getrusage(resource.RUSAGE_SELF).ru_utime; t0=time.perf_counter()
    for _ in range(3): llm.create_embedding([text])
    w=time.perf_counter()-t0; c=resource.getrusage(resource.RUSAGE_SELF).ru_utime-u0
    print(f"   wall={w/3*1000:.0f}ms par={c/w:.2f}x {177*3/w:.0f} tok/s")
    llm.close()
