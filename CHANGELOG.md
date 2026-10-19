# Changelog

## 0.1.1

修复 `todo_board` 工具在某些情况下不出现的问题。

- **工具改为在插件自己的 ctx 上全局注册**。0.1.0 按 root Agent 挂载工具，只在插件启动时遍历 `ctx.agents.roots()` 并监听 `agent/created`；插件热装时当前 session 的 Agent 已经存在，不会再次触发 `agent/created`，工具就此静默丢失。现在注册一次，对所有 Agent（含子 Agent）可见。
- `inject` 由 `agents` 改为 `tools`，与上面的实现一致。
- 仓库补 `node_modules` 被清理后的说明：链接安装时若 `@deepseek-ai/dsh-tools` 解析失败，只会失去工具，面板与 RPC 不受影响。

## 0.1.0

首个公开版本。

- 侧栏待办面板，主区域支持**列表**与 **Markdown** 两种视图，同一份数据
- 新建条目自动补齐**创建时间、提醒时间与提醒模式**
- 四种提醒模式 `none` / `once` / `daily` / `lead`，切换模式时自动补齐该模式所需的字段
- `todo_board` agent 工具，与面板共用同一组 Host 方法
- 数据存于 `~/.dsh/dsh-todo/state.json`，原子写入
- 样式只用 `--dsw-alias-*` 主题令牌，浅色/深色跟随宿主
