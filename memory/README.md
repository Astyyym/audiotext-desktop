# 项目记忆索引（memory/）

每次到访先读本文件，再按需读下列主题文件。这里只放**稳定、需每次知晓**的项目事实、环境边界与坑；详细证据见 `docs/internal/findings.md`，产品范围见 `docs/PRD.md`。

| 文件 | 内容 |
|---|---|
| [01-project-context.md](01-project-context.md) | 产品是什么、边界、用户、关键决策 |
| [02-environment-and-stack.md](02-environment-and-stack.md) | 技术栈、依赖、模型格式、性能基线、打包/许可边界 |
| [03-pitfalls.md](03-pitfalls.md) | 高频踩坑与规避 |

> 写入规则：项目事实/坑/约定写到 `memory/`，不写到全局记忆；含敏感信息（密钥、个人数据、本机绝对路径）不得提交。规则性、每轮都必须成立的约束放在 `AGENTS.md`。
