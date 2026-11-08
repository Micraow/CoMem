import os, sys, time
import numpy as np
a = np.random.rand(1024,1024).astype(np.float32); b = np.random.rand(1024,1024).astype(np.float32)
a@b
t0=time.perf_counter()
for _ in range(20): a@b
dt=time.perf_counter()-t0
print(f"threads={os.environ.get('OMP_NUM_THREADS','?')}  {20/dt:.0f} matmul/s  {20*2*1024**3/dt/1e9:.0f} GFLOPS")
