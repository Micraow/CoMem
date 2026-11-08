import sys, time
sys.path.insert(0, '/home/micraow/workspace/CoMem/local-inference')
from llama_cpp import Llama, LLAMA_POOLING_TYPE_LAST
text = "The quick brown fox jumps over the lazy dog. CoMem 是面向 AI agent 的上下文记忆数据库。" * 8
llm = Llama(model_path='models/Qwen3-Embedding-0.6B-Q8_0.gguf', embedding=True,
            n_ctx=8192, n_batch=8192, n_threads=6, n_gpu_layers=0,
            pooling_type=LLAMA_POOLING_TYPE_LAST, verbose=False, seed=0)
print("n_ubatch:", getattr(llm.context_params, 'n_ubatch', 'N/A'))
print("n_threads:", llm.context_params.n_threads)
print("n_threads_batch:", getattr(llm.context_params, 'n_threads_batch', 'N/A'))
llm.create_embedding([text])
t0 = time.perf_counter()
for _ in range(3):
    llm.create_embedding([text])
print(f"{(time.perf_counter()-t0)/3*1000:.0f} ms/call")
llm.close()
