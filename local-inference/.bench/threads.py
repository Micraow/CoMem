import sys
sys.path.insert(0, '/home/micraow/workspace/CoMem/local-inference')
import llama_cpp
from llama_cpp import Llama, LLAMA_POOLING_TYPE_LAST
llm = Llama(model_path='models/Qwen3-Embedding-0.6B-Q8_0.gguf', embedding=True,
            n_ctx=1024, n_batch=512, n_threads=6, n_threads_batch=6, n_gpu_layers=0,
            pooling_type=LLAMA_POOLING_TYPE_LAST, verbose=False, seed=0)
ctx = llm._ctx.ctx
print("ctx n_threads =", llama_cpp.llama_n_threads(ctx))
print("ctx n_threads_batch =", llama_cpp.llama_n_threads_batch(ctx))
print("model n_params =", llama_cpp.llama_model_n_params(llm.model))
print("n_ctx =", llama_cpp.llama_n_ctx(ctx))
llm.close()
