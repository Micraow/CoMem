## 已有经验

{{existingExperiences}}

## 本次会话

{{messages}}

## 任务

每条消息都有独立的 `messageId` 和 `角色`。输出里的 `evidence.role` 必须与该消息的角色一致，
`evidence.quote` 必须逐字复制该消息正文中的连续文本。不得引用没有出现在这里的 ID。

按上面的格式输出 JSON。没有可复用的经验时输出空数组。
