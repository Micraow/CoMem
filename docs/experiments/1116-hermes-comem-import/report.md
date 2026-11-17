# Hermes、OpenUI 与 CoMem 历史会话导入联合验证

2026-11-16，基线 `4457b6d`，导入引导 `0f8a0c6`。使用官方 Hermes v0.23.1 Webapp 和当时随 CoMem 维护的 `hermes-openui` 显示插件，未改 Hermes 源码。Hermes 与 CoMem 的生成和抽取使用 Comate DeepSeek V4.1 Flash，经本机 OpenAI 兼容网关。CoMem 配置 `retrieval.engine: vector`，嵌入是本机 CPU 上的 Qwen3-Embedding-0.6B（1024 维，关闭重排），摘要用规则生成器。CoMem、Web 控制台、Hermes 均使用独立测试目录和回环端口。所有聊天材料和用户均为合成数据。

| 验证 | 操作与核对结果 |
|---|---|
| Codex 原生日志导入 | `pnpm ingest --source codex --config "$RUN/comem.yaml" --data-dir "$RUN/data" --json`。日志含 `session_meta` 及两条 `response_item` 消息。归档 1 个会话、2 条消息；1 个任务完成，提炼 3 条记忆（2 条生效、1 条待复核）。相同输入的 CLI 重跑跳过 1 个会话，未追加消息。 |
| 新会话召回与流式显示 | Hermes 新会话配置 CoMem HTTP MCP，开放 `find`、`read`、`remember`。先发普通消息，再发 `/hermes-openui:openui`，仅询问旅行相册的归档约定。Hermes 记录了 `find` 与 `read` 调用，返回的卡片包含只在导入材料中提供的代号 `雨燕-73`。Chromium 在 `message.complete` 之前观察到卡片，整轮记录 79 个 `message.delta`，完成后可切换「建议 / 依据」。 |
| 网页入口与确认 | 在 Chromium 初始化并登录隔离控制台，从「会话与任务」打开导入卡，复制内容与提示词源文件逐字一致；展开、收起和 390px 宽度下的卡片无横向溢出。把实际剪贴板内容和一份无日期的 TXT 文件位置交给 Hermes。Agent 找出 1 个会话的 2 条消息，给出预览，明确确认前无新归档。确认后 `remember` 创建归档，原文、角色和确定性占位时间均可在归档验证。 |
| 提炼、去重与复核 | SQLite 显示两次会话提交均经历 `memory_extract`、`memory_merge` 等步骤。TXT 生成两条生效记忆，用不含原代号的语义问题找回 `水杉-61`。通过 MCP 重投同一消息和时间得到 `taskId: none`；用最终版网页提示词在新 Agent 会话中再次导入相同 TXT，也没有新增归档。复核验证使用合成经验条目：目录范围内，待复核不返回，通过后等待向量索引更新可返回；Codex 导入的经验条目获批后也在经验目录检索中返回。 |

复跑需要在隔离配置里指定实际网关地址、模型和嵌入；模型密钥用环境变量。启动 `pnpm dev:server --config "$RUN/comem.yaml" --data-dir "$RUN/data"`，再将 `COMEM_SERVER_PORT` 指向该端口后运行 `pnpm dev:web`。按[插件使用说明](https://github.com/Micraow/hermes-openui/blob/main/docs/INSTALL.md#install-hermes-openui)启动官方 Hermes Webapp，在隔离 Hermes 配置中添加 `<CoMem 地址>/mcp`；再按[导入说明](../../ingest-prompt.md)验证。核对 CoMem 归档 `messages.jsonl`、SQLite `task.steps_done`、`node` 状态、`node_embedding` 的维度以及 Hermes `messages.tool_name`，可区分模型回答、工具调用与后台处理。原始浏览器脚本、截图与运行日志保存在本机忽略目录 `local/1116-hermes-comem-joint/`，不纳入版本控制。

范围：只验证了一份 Codex 导出（CLI 路径）和一份纯文本（Agent 路径）。对其它导出格式的解析质量受 Agent 和文件本身影响。相同导入的去重要求规范化结果一致；不覆盖跨入口去重、改过的文件或并发。此实验没有测量日常使用收益，也未验证 Hermes Memory Provider、自动采集或自动注入。OpenUI 验证覆盖当前移植的卡片和交互，没有验收完整上游组件库。已观察到 `find` 对同一已通过条目使用目录范围能命中，使用该条目的文件 URI 作 `targetUri` 时返回 0；本次结果采用目录范围。

随后用隔离 Hermes（仅接 MCP）和新版网页提示词导入另一份无日期 TXT。在浏览器核对了剪贴板、预览中的实际账号、确认前零归档、确认后的真实归档地址，以及文件树里的完整原文。提交任务执行了提炼与合并，生成一条待复核规则。其编码后的 URI 超过路由默认长度，最初在「通过」时返回 HTTP 414；修复后同一条记录在网页成功通过，`rule_search` 以任务描述找回原始约定。MCP 仍报告 16 个工具。用同一生成模型运行「整理建议」，经历两轮模型决策，未修改记忆文件或待复核队列。真实浏览器脚本与合成材料位于本地忽略目录 `local/import-receipt-check/`。新版 OpenUI 和 Memory Provider 的验证见[独立报告](provider.md)。OpenUI 现已迁移到 [Micraow/hermes-openui](https://github.com/Micraow/hermes-openui)，此迁移不重新验收本报告记录的功能。
