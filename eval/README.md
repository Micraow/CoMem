# 检索质量评估

`pnpm eval` 用一份带标注的数据集测量「检索到底好不好」。它回答三个问题：

- **召回**：该找的东西有没有被找出来（Recall@k）。
- **排序**：第一个相关结果排在第几（MRR）、相关程度高的有没有更靠前（nDCG@k）。
- **代价**：一次查询要多少毫秒（p50 / p95）。

没有评估集时，改一个参数只能靠感觉；有了它，`retrieval.levelWeights`、
`retrieval.rerank.*`、`retrieval.engine` 的每一次调整都能给出「变好还是变坏」。

## 快速开始

```bash
pnpm eval                                   # 跑 eval/datasets/basic.yaml，三个引擎
pnpm eval --k 5                             # 只算前 5 名
pnpm eval --engines fts5,vector             # 只跑指定引擎
pnpm eval --json                            # 机器可读输出
```

输出是一张可以直接贴进文档的表格：

```
数据集 basic（34 条查询，k=10）

┌───────────────┬───────────┬───────┬─────────┬──────────┬──────────┐
│ 变体          │ Recall@10 │   MRR │ NDCG@10 │      p50 │      p95 │
├───────────────┼───────────┼───────┼─────────┼──────────┼──────────┤
│ fts5          │     0.387 │ 0.355 │   0.355 │    0.2ms │    0.3ms │
│ vector        │     0.963 │ 0.907 │   0.907 │  380.6ms │  451.1ms │
│ hybrid        │     0.963 │ 0.909 │   0.911 │  396.6ms │  600.1ms │
│ hybrid+rerank │     0.990 │ 0.956 │   0.959 │ 1788.5ms │ 3222.3ms │
│ hybrid+levels │     0.963 │ 0.909 │   0.911 │  550.7ms │  943.5ms │
└───────────────┴───────────┴───────┴─────────┴──────────┴──────────┘
```

（这是本机 2026-11-08 的真实数字，数据根是临时目录，向量来自远程 bge-m3，
延迟里包含一次查询嵌入的网络往返。换机器、换供应商后会变。表格由
`pnpm eval --config local/eval-config.yaml --rerank --level-weights 1,1,1` 生成。）

### 追加对照变体

`--engines` 只选默认的三个单引擎变体；下面几个开关各自**追加**一个变体：

| 开关 | 追加的变体 | 回答的问题 |
|---|---|---|
| `--rerank` | `hybrid+rerank` | 重排到底提升多少 |
| `--hotness-weight 0.1` | `hybrid+hotness=0.1` | 热度加权是帮忙还是帮倒忙 |
| `--level-weights 1,1,1` | `hybrid+levels` | 层级先验是调好了还是调坏了 |

重排变体需要 `providers.rerank` 配好（`retrieval.rerank.enabled` 的交叉校验
要求它不是 `disabled`）。没有配置时容器创建会抛 `INVALID_ARGUMENT`，不会静默
退回「不重排」。候选文本**摘要优先、正文兜底**：摘要在索引里就有，摘要为空
（存量记忆、非记忆文件）时读正文前 512 个字符——不兜底时空文本候选会被
`applyRerank` 全部跳过，重排等于没开。

`--level-weights` 追加的是 `hybrid+levels`，与默认变体 `hybrid` 对比。层级权重
在 `hybrid` 下乘在每个后端对 RRF 融合分的贡献上（`levelWeight / (k + rank)`），
不是只改单引擎的排序分。传 `1,1,1` 就是关掉这个先验（标准 RRF），所以
`hybrid+levels` 与 `hybrid` 的差异直接回答「1.15 / 1.05 / 1.00 这组经验值在
`hybrid` 下有没有用」。

```bash
pnpm eval --config local/eval-config.yaml --rerank
```

`--config` 用一份不同的配置文件（默认 `config.yaml`），适合放评估专用的供应商。

## 数据集格式

`eval/datasets/*.yaml`（JSON 同样可以，解析后是同一个对象）：

```yaml
name: basic
description: 一句话说明这份数据集覆盖什么。

corpus:
  "comem://user/lin/memories/preferences/code-style.md": |
    代码风格偏好

    仓库统一使用 TypeScript 严格模式，缩进两个空格。

cases:
  - query: 严格
    relevant:
      - comem://user/lin/memories/preferences/code-style.md
    graded:
      comem://user/lin/memories/preferences/code-style.md: 3
```

规则：

- `corpus` 的 key 必须是合法的 `comem://` URI，且必须是**规范形态**（NFC、
  无末尾斜杠、无重复斜杠）。规范化之后与原文不同的 key 会在写入时变成另一个
  地址，标注却还是原文——两边对不上。
- 所有语料必须属于**同一个 `user` 根**。执行器把它们绑成服务图身份
  （`comem://user/{rootId}` → `user:{rootId}`）。`group` 根不支持：组作用域的
  权限依赖成员关系，评估容器没有。
- `cases[].relevant` 里的 URI 必须在 `corpus` 里，`graded` 的 key 也是。引用
  不存在的文档会在解析时抛 `INVALID_ARGUMENT`，不会静默跳过。
- `graded` 的值域是 `0–3` 的整数。没出现在 `graded` 里的 `relevant` 文档按 1 算。
- `cases` 不能为空。

**每条查询都要写清「为什么这几条相关」**（YAML 注释）。标注本身没有解释就
无法复核，而评估最容易做假的地方就是标注。

### 写语料的注意事项

- 语料要真实：从项目文档、真实使用场景里取，不要 `foo` / `bar` / `lorem`。
  合成语料上的召回率没有迁移性。
- **不要把答案写进文档**。query 是「怎么配置 TypeScript 严格模式」，文档的
  标题就该是「TypeScript 严格模式配置」；在正文里写「这条文档回答了……」等于
  把查询串直接塞进索引，FTS5 的短语匹配会无条件命中。
- 难负例（`graded: 0`）要真的字面相似：`记忆化缓存` 与 `记忆` 共享字符，
  但一个讲 memoization、一个讲跨会话知识存储。

## 指标

实现在 `src/eval/metrics.ts`，纯函数，无 IO。

| 指标 | 公式 | 来源 |
|---|---|---|
| Recall@k | `\|top-k ∩ relevant\| / \|relevant\|` | 标准 IR 定义 |
| MRR | `1 / rank_of_first_relevant`（rank 从 1 起） | 标准 IR 定义 |
| nDCG@k | `DCG@k / IDCG@k`，`DCG = Σ (2^rel_i - 1) / log2(i + 1)` | Järvelin & Kekäläinen (2002) |

两个明确的取舍：

- **`relevant` 为空时 Recall 返回 1**，不是 0。空标注表示「这条查询没有该找的
  东西」，检索没有做错任何事。返回 0 会把「数据集没标注」记成「检索失败」。
- **`graded` 为空时 nDCG 返回 0**。分子分母同时为 0，没有可归一化的基准。
  这与 Recall 的 1 不矛盾：召回率有「没有该找的」这个自然解释，nDCG 没有。

聚合是各指标的算术平均。数据集里每条查询权重相同；需要按业务重要性加权时，
拆成多个数据集跑，不要在指标层引入权重。

## 执行方式

- **每个变体一个临时数据根**（`fs.mkdtemp`）。变体之间的索引、向量、权限表
  完全隔离——否则「hybrid 比 fts5 好」可能只是「hybrid 跑在 fts5 建好的索引上」。
- **延迟只测 `find()` 调用本身**。建容器（迁移、建表、根预置）与播种语料
  （写文件 + 嵌入）在计时窗口之外。
- **每个查询跑 3 次取中位数**。第一次带冷缓存成本（SQLite 页缓存、
  `sqlite-vec`、FTS5 段缓存）；3 是「能算中位数」的最小奇数。命中取最后一次
  （热缓存稳定态）的结果。
- **变体切换必须重建容器**。重排 / 热度 / 层级权重 / 引擎都是容器级配置，
  没有热改入口；重建成本已经被「延迟窗口之外」隔离掉。

### 评估强制覆盖的配置

以下配置**不由** `config.yaml` 决定，评估时固定：

| 配置 | 值 | 理由 |
|---|---|---|
| `summary.generator` | `rule` | 摘要生成会调模型（一次约 10 秒），评估只关心检索；规则摘要同时保证 L0 文本可复现 |
| `session.autoCommit.enabled` | `false` | 不启动后台调度器，避免与检索无关的写入 |
| `session.expiry.idleTimeoutSeconds` | `0` | 同上 |
| `logging.level` | `fatal` | 容器日志走 stdout，会割裂表格 / JSON。执行器在变体零命中时自己补一条告警 |

## 已知限制

1. **热度变体需要访问历史。** `--hotness-weight` 会真的把配置接上，但临时数据
   根里 `access_count` 全是 0，热度分对排序没有影响。要测「0 比 0.1 好还是坏」，
   得先给语料造访问记录（例如直接改 `node.access_count` / `last_accessed_at`），
   而数据集格式目前没有这一列。这不是「没接」——是「没有数据可测」。
2. **向量变体的延迟包含网络往返。** `find` 在向量 / 混合引擎下要嵌入查询，一次
   远程调用 300–900ms。这是生产延迟的真实组成部分，但它把「索引本身多快」盖住
   了。要比索引延迟，看 `fts5` 变体。
3. **`group` 作用域不支持。** 见数据集格式。
4. **评估是单用户的。** 容器绑定一个身份，语料必须属于同一个 `user` 根。
   权限过滤仍然生效（`node_permission` 的 allow/deny 谓词），但只有一组主体。
5. **没有统计显著性。** 34 条查询上 0.02 的差距可能是噪声。报告给的是点估计，
   不是置信区间；要判断「真的变好了」，至少扩到几百条查询。
6. **层级加权在 k=10 上看不出**指标**差别。** 当前数据集的标注全是文件（L2 记录）；
   目录的 L0 摘要虽然进了索引、也出现在 `sqlite-vec` / `bge-m3` 这类查询的
   top-10 里，但没有被标成相关文档。层级先验只改变这些 L0 记录的名次（实测
   `bge-m3` 查询下 `memories` 目录从第 4 名掉到第 5 名、`rerank-model.md` 从第 5
   名升到第 4 名），不改变**相关文档**的名次，所以 `hybrid+levels`
   （`--level-weights 1,1,1`）与 `hybrid` 的三项指标逐位相同。这不是「加权没
   接线」——接线由 `tests/integration/services/search-hybrid.test.ts` 的「层级
   权重」用例钉住（同分候选，L0 的融合贡献是 L2 的 1.15 倍）。要让它可测，得把
   目录摘要标成相关文档，而数据集格式目前要求 `relevant` 引用的 URI 必须在
   `corpus` 里（目录不是 corpus 的 key）。

## 当前基线

`eval/datasets/basic.yaml` 的 34 条查询（2026-11-08，本机，远程 bge-m3）：

| 变体 | Recall@10 | MRR | NDCG@10 | p50 | p95 |
|---|---:|---:|---:|---:|---:|
| fts5 | 0.387 | 0.355 | 0.355 | 0.2ms | 0.3ms |
| vector | 0.963 | 0.907 | 0.907 | 380.6ms | 451.1ms |
| hybrid | 0.963 | 0.909 | 0.911 | 396.6ms | 600.1ms |
| hybrid+rerank | 0.990 | 0.956 | 0.959 | 1788.5ms | 3222.3ms |
| hybrid+levels | 0.963 | 0.909 | 0.911 | 550.7ms | 943.5ms |

读法：FTS5 在自然语言改写上召回低（短语匹配要求字符相邻），在专有名词 /
标识符上召回 1.0；向量反过来。混合检索不是「永远更好」，它把两者的错误率
平均掉——具体哪条查询谁赢，看 `docs/operations.md` 的「检索质量评估」一节。

**重排确实改变了指标**（`hybrid+rerank` 0.990 / 0.956 / 0.959，三项都比
`hybrid` 高），代价是 p50 从 396.6ms 涨到 1788.5ms：候选文本摘要为空时要读
正文，加上一次模型调用。**`hybrid+levels` 与 `hybrid` 逐位相同**，原因见
「已知限制」第 6 条——不是加权没接线，而是这批标注里没有相关的 L0/L1 文档。
