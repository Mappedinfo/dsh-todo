/**
 * dsh-todo Host 半边：全局待办存储、浏览器 RPC、agent 工具与提醒扫描。
 *
 * 面板与 agent 工具都只通过这里导出的同一组服务方法操作数据；
 * 渲染与时间运算分别在 Client 与 store/markdown 里，Host 只持有状态。
 */
import { parseMarkdown, renderMarkdown } from './markdown.js'
import { registerTodoRpc } from './rpc.js'
import { TodoStore, viewTodo } from './store.js'
import { createTodoTool } from './tools.js'

export const name = 'dsh-todo'

export const inject = [
  // connection / webServer 是 RPC 通道的两端：缺一不可，故走硬依赖。
  'timer', 'tools', 'connection', 'webServer',
]

/**
 * 插件可调参数写在 cordis.patch.yml 的行配置里（见 README），
 * 这里不做强制校验，缺省值由 TodoStore 兜底。
 */

export function apply(ctx, rawConfig = {}) {
  ctx.effect(() => {
    const store = new TodoStore({
      file: rawConfig.stateFile ?? undefined,
      reminderMode: rawConfig.defaultReminderMode,
      reminderDelayMinutes: rawConfig.defaultReminderDelayMinutes,
      reminderTime: rawConfig.defaultReminderTime,
      reminderGranularityMinutes: rawConfig.reminderGranularityMinutes,
      leadMinutes: rawConfig.defaultLeadMinutes,
    })

    /** 面板与工具共用的操作面。返回的都是归一化后的条目。 */
    const api = {
      snapshot: () => store.snapshot(),
      view: (id) => {
        const todo = store.find(id)
        if (todo === undefined) throw new Error(`待办不存在：${id}`)
        return viewTodo(todo, new Date())
      },
      markdown: (locale) => renderMarkdown(store.snapshot(), locale),
      create: (input) => store.create(input),
      update: (id, patch) => store.update(id, patch),
      toggle: (id) => store.toggle(id),
      remove: (id) => store.remove(id),
      clearCompleted: () => store.clearCompleted(),
      reorder: (ids) => store.reorder(ids),
      setPrefs: (patch) => store.setPrefs(patch),
      sweep: () => store.sweepReminders(),
      /** Markdown 视图的「保存」：文本先解析回条目，再整体替换。 */
      saveMarkdown: (text, locale) => {
        store.replaceAll(parseMarkdown(text, store.list()))
        const snapshot = store.snapshot()
        return { ...snapshot, markdown: renderMarkdown(snapshot, locale) }
      },
    }

    let alive = true
    let removeRpc = async () => {}
    let removeTools = () => {}
    let stopTimer = () => {}

    const cleanup = async () => {
      alive = false
      for (const stop of [stopTimer, removeTools]) {
        try {
          stop()
        } catch (error) {
          ctx.logger.warn(`dsh-todo: lifecycle cleanup failed: ${String(error)}`)
        }
      }
      await removeRpc()
      await store.flush()
    }

    return (async () => {
      await store.load()

      removeRpc = await registerTodoRpc(ctx, api)

      // 工具注册在插件自己的 ctx 上，对所有 Agent 可见。
      // 不按 root Agent 挂载：插件热装时当前 session 的 Agent 已经存在，
      // 不会再触发 agent/created，按 Agent 挂会静默丢掉工具。
      let defineTool = null
      try {
        ({ defineTool } = await import('@deepseek-ai/dsh-tools'))
      } catch (error) {
        ctx.logger.warn('dsh-todo: @deepseek-ai/dsh-tools 不可解析，本次不注册 todo_board 工具（面板与 RPC 不受影响）')
      }
      if (defineTool !== null) {
        try {
          removeTools = ctx.tools.register(createTodoTool(defineTool, api))
        } catch (error) {
          // 定义与宿主注册表不兼容时，宁可没有工具也不要拖垮整个插件。
          ctx.logger.warn(`dsh-todo: todo_board 注册失败，跳过：${String(error)}`)
        }
      }

      const scanSeconds = Number.isFinite(rawConfig.reminderScanSeconds)
        ? Math.min(3600, Math.max(5, Math.round(rawConfig.reminderScanSeconds)))
        : 30
      stopTimer = ctx.setInterval(() => {
        try {
          const due = store.sweepReminders()
          if (due.length > 0) {
            ctx.logger?.info?.(`dsh-todo: ${due.length} reminder(s) became due`)
          }
        } catch (error) {
          ctx.logger.warn(`dsh-todo: reminder scan failed: ${String(error)}`)
        }
      }, scanSeconds * 1000)

      return cleanup
    })()
  }, 'dsh-todo: host service')
}