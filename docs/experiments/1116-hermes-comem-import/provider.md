# Hermes 自动记忆验收

在隔离的官方 Hermes v0.23.1 Webapp 与 CoMem 实例中验证。生成与抽取使用实际的 Comate DeepSeek V4.1 Flash；向量由本机 CPU 上的 Qwen3-Embedding-0.6B 生成（1024 维）。两份 Hermes 配置使用相同模型、相同的原生 `MEMORY.md` / `USER.md` 合成内容，只在测试配置中启用 CoMem Memory Provider。未接入 CoMem MCP，不使用真实用户会话。

| 项目 | 实测结果 |
|---|---|
| 自定义地址 | `hermes memory status` 显示隔离实例的 API 端口 19572。实际 Webapp 请求到达同一端口。 |
| 自动归档 | 用户发送包含秘密测试代号的咖啡豆盘点约定。回复完成后，收到 `/sessions`、`/messages`、`/commit` 的 HTTP 200；归档有一条 `user` 和一条 `assistant`，来源为 Hermes。 |
| 归档到可用记忆 | 提交任务执行 `memory_extract`、`memory_merge` 等步骤。模型给出的规则和经验起初待复核。在网页通过经验后，索引显示该记录生效并拥有 1024 维向量。 |
| 关外部记忆 | 在新会话中问「我给每周咖啡豆盘点约定的固定识别码是什么？」。关闭 Provider 的 Hermes 回答不知道，CoMem 没有收到相应调用。 |
| 开外部记忆 | 在新会话中问相同问题。CoMem 收到 `/context` 成功请求，Hermes 回答了正确代号。Hermes 消息表没有 CoMem MCP 调用。 |
| 同一聊天使用完整 OpenUI | 更新到 55 组件的构建，在成功召回后的同一新会话，请 Comate DeepSeek V4.1 Flash 用 `/hermes-openui:openui` 生成「约定／核对」卡片。Playwright 在第二次 `message.complete` 前已看到卡片，最终卡片包含正确代号。 |

复跑可按 [Hermes 快速上手](../../hermes-quickstart.md) 在两套隔离配置中做。先在启用配置里提供一个只有测试聊天里出现的随机识别码，检查归档和任务；如有待复核经验，先通过。两套配置都开新会话，发送相同的问题，检查回复及服务端请求记录。OpenUI 已迁移到独立仓库，安装见 [Micraow/hermes-openui](https://github.com/Micraow/hermes-openui/blob/main/docs/INSTALL.md#install-hermes-openui)。测试原始日志与页面截图位于本地忽略目录 `local/hermes-provider-acceptance/`。

本次只证明一个受控问题的自动召回、使用和当时 OpenUI 版本的联合输出。没有测量长期收益、召回覆盖率或真实长会话中的误抓率。远程认证、更换账号及网络失败的队列行为有 Provider 测试；上述真机链路使用回环实例。完整组件、状态和配置查询的覆盖见 [OpenUI 移植说明](https://github.com/Micraow/hermes-openui/blob/main/docs/PARITY.md)。仓库迁移不重新验收上述结果。
