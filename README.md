# dsh-todo

DeepSeek Harness 插件：在侧栏加一个**待办清单**面板，支持**列表视图**与 **Markdown 视图**切换；新建条目时自动补齐**创建时间、提醒时间与提醒模式**。

面板、agent 工具和 Markdown 视图共用同一份 Host 端数据与同一组服务方法，不存在两套逻辑。

社区介绍与讨论见 [DSH Show Your Plugins!](https://github.com/deepseek-ai/deepseek-harness/discussions/10226)。本项目为**非官方**社区插件，独立维护，未经 DeepSeek 官方审核。

## 安装

```sh
# 从 GitHub 安装（当前可用）
dsh plugin --profile <你的 profile> add github:Mappedinfo/dsh-todo

# npm 包发布后
dsh plugin --profile <你的 profile> add @mappedinfo/dsh-todo
```

也可以在 DSH 的插件页用 Add 填入同一个地址。`<你的 profile>` 是 profile 名（例如 `web`）；Electron 桌面版的 `desktop` profile 由应用自身管理。

装完侧栏出现待办图标。数据落在 `~/.dsh/dsh-todo/state.json`，用 `stateFile` 配置项可改路径。

`@deepseek-ai/dsh-tools` 是唯一的运行期依赖，用来注册 `todo_board` 工具；它取不到时插件照常提供面板与 RPC，只记一条 warn 日志。

---

## 界面

**侧栏**多一个待办图标，点击后在主区域打开面板。

### 列表视图

- 顶部输入框回车即新建；**新建时自动写入创建时间、提醒时间、提醒模式**
- 筛选：全部 / 待办 / 今天 / 已完成
- 每行显示复选框、标题，以及创建时间、提醒模式与提醒时刻、截止时间、优先级、标签等标签
- 点任意一行展开编辑器：标题、备注（支持 Markdown）、提醒模式、提醒时间、提前分钟、截止时间、优先级、标签
- 逾期、今日到期、待提醒、已提醒分别用不同状态色标出

### Markdown 视图

- **预览**：整份清单渲染成 Markdown，任务项的复选框可以直接点，完成状态立刻写回列表
- **源码**：直接编辑 Markdown 文本，点「已写回清单」解析回条目
- 「复制」把当前 Markdown 放进剪贴板

两个视图切换的是**同一份数据**：列表新建的条目立刻出现在 Markdown 里，Markdown 里改的标题与勾选状态保存后也立刻反映到列表。

### 自动创建的三个时间字段

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| 创建时间 `createdAt` | 建条目那一刻 | 永远存在 |
| 提醒时间 | 按提醒模式计算 | `once` = 现在 + 提前量；`daily` = 每日时刻；`lead` = 截止时间 − 提前分钟 |
| 提醒模式 | 配置默认值 `defaultReminderMode` | `none` / `once` / `daily` / `lead` |

默认提醒时间会向上取整到最近的 5 分钟刻度；`once` / `lead` 模式下它同时作为截止时间的默认值。三个字段都可以在编辑器里改，改成其他模式时会自动补齐该模式需要的字段（例如切到「每日」但没填时刻时补默认时刻）。

提醒模式：

| 模式 | 含义 | 下次提醒 |
| --- | --- | --- |
| `none` | 不提醒 | — |
| `once` | 一次性提醒 | 指定的那个时刻 |
| `daily` | 每日提醒 | 下一个 `HH:mm` |
| `lead` | 截止前提醒 | 截止时间 − 提前分钟 |

## agent 工具

模型通过 `todo_board` 操作同一份清单：

```
action: list | add | update | toggle | remove | clear_done | markdown
title / id / done / note / mode / remind_at / remind_time / lead_minutes / due / priority / tags
```

工具与面板调用的是同一个 Host 方法，所以状态变化与失败原因一致。`add` 不带 `mode` / `remind_at` 时同样走「自动创建时间 + 提醒时间 + 提醒模式」这条路径。

## 数据

- 默认落在 `~/.dsh/dsh-todo/state.json`（单个 JSON，`version: 1`），写入用「临时文件 + rename」原子替换，失败不影响交互
- 文件缺失或损坏时回落到空清单，不会阻塞宿主启动
- 用 `stateFile` 配置项可以改路径

## 配置

写在 `cordis.patch.yml` 的 `config` 里：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `stateFile` | `null` | 状态文件路径；`null` 表示 `~/.dsh/dsh-todo/state.json` |
| `defaultReminderMode` | `once` | 新建条目的默认提醒模式 |
| `defaultReminderDelayMinutes` | `60` | `once` / `lead` 模式默认提前多少分钟 |
| `defaultReminderTime` | `'09:00'` | `daily` 模式的默认每日时刻（本地 `HH:mm`） |
| `reminderGranularityMinutes` | `5` | 默认提醒时间向上取整的刻度，`0` 表示不取整 |
| `defaultLeadMinutes` | `10` | `lead` 模式的默认提前分钟 |
| `reminderScanSeconds` | `30` | 提醒扫描间隔（秒） |

## 提醒怎么呈现

提醒到点后，插件在 Host 记账（`remindedAt`）并在面板上出现「待提醒」标记与一次顶部提示，条目上显示「已提醒」。**插件不代替用户操作**：不注入会话、不打断正在跑的 turn，也不自动勾选或延后任何条目。

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 入口：`inject`、存储加载、RPC 路由、按 Agent 挂载工具、提醒扫描 |
| `store.js` | 数据模型、提醒时间计算、原子持久化、快照视图模型 |
| `markdown.js` | Markdown 生成与解析（双向，保留 id / 备注 / 提醒设置） |
| `rpc.js` | 浏览器 → Host 的 JSON RPC 前缀路由 |
| `tools.js` | `todo_board` agent 工具 |
| `client.js` | 面板：侧栏图标 + 主区域列表 / Markdown 双视图、主题令牌样式 |
| `scripts/smoke.mjs` | 纯逻辑自检（不依赖 DSH 运行时） |

## 自检

```bash
node scripts/smoke.mjs          # 14 项：自动时间/提醒、模式切换、提醒扫描、Markdown 往返、持久化
node scripts/client-smoke.mjs   # 10 项：用桩 loader 真正执行 client.js 的 factory 与渲染
node --check client.js          # 浏览器半边的语法
```

`client-smoke.mjs` 会执行 bundle 的 `factory` 与 `apply`，断言两个槽位注册（`sidebar.panellist:todo` / `main:todo`）、zh/en 语言包、样式只用主题令牌、列表视图与 Markdown 预览 / 源码两种模式各自渲染出什么，以及卸载时全部清理干净。

## 从源码开发

插件没有构建步骤，克隆后直接链接进 profile 即可：

```bash
git clone https://github.com/Mappedinfo/dsh-todo.git
cd dsh-todo
dsh plugin --profile <你的 profile> add "$PWD"
```

本地开发时 `@deepseek-ai/dsh-tools` 可能不在解析路径里（它随 DSH 安装或源码检出提供）。可以指向本地 DSH 源码检出：

```bash
mkdir -p node_modules/@deepseek-ai
ln -sfn <dsh 源码检出>/packages/core/tools node_modules/@deepseek-ai/dsh-tools
```

不建这个链接也只会失去 `todo_board` 工具，面板与 RPC 不受影响。`node_modules/` 已被 `.gitignore` 排除。

从 npm 或 GitHub 正常安装时，这个依赖由包管理器装上，不需要手工链接。

装好后侧栏即出现待办图标。页面通过模块图热更新拿到新的浏览器模块，通常不必刷新；若图标没出现，刷新一次即可。

## 实现取舍

- **RPC 走 `ctx.webServer` 前缀路由**而不是 `ctx.connection.rpc.handle()`：后者自 DSH 0.1.5 起内部通过 connection 自己的 `ctx` 取 `webServer`，插件调用会抛 `cannot get property "webServer" without inject`。因此 `inject` 里必须同时声明 `connection` 与 `webServer`。
- **样式只用 `--dsw-alias-*` 主题令牌**，不引入任何 Harness Client 包（如 `@deepseek-ai/dsh-client-ui-primitives`），因此浅色/深色自动跟随宿主。
- **样式表随面板挂载**：插件 bundle 的 `factory` 只拿到 `require`；`styles` / `host` / `console` 是**动态 Client runner** 的 builtin，在 `window.__ModuleLoader__` bundle 里并不存在。早期版本调用 `styles.insert()` 抛 `ReferenceError: styles is not defined`，使整个 web boot 卡在 `@mappedinfo/dsh-todo: loading`。现在改成面板树里的 `<style>` 元素，随组件卸载由 React 移除；`scripts/client-smoke.mjs` 刻意不提供这些 builtin 来挡住这类回归。
- **时间运算全在 Host**：`Client` 只回传 `datetime-local` / `time` 输入的本地字符串，两侧不必各写一份时区换算。
- **没有构建步骤**：Host 是原生 ESM，Client 是 `window.__ModuleLoader__.load` 工厂 + `React.createElement`。