/**
 * agent 工具：与面板动作共用同一组 Host 服务方法。
 *
 * 这里不复制任何业务逻辑——面板调用的 `api.create` / `api.toggle` 等
 * 就是本工具调用的方法，因此两条路径的状态变化与失败原因必然一致。
 *
 * `defineTool` 由调用方注入而不是静态 import：`@deepseek-ai/dsh-tools` 只存在于
 * DSH 安装目录或源码检出中，取不到时插件仍然照常提供面板与 RPC，只是没有工具。
 */

const ACTIONS = ['list', 'add', 'update', 'toggle', 'remove', 'clear_done', 'markdown']
const MODES = ['none', 'once', 'daily', 'lead']
const PRIORITIES = ['low', 'normal', 'high']

function render(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

const JSON_OUTPUT = { schema: { type: 'json' }, render }

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

function requireId(args) {
  const id = typeof args.id === 'string' ? args.id.trim() : ''
  if (id === '') throw new Error('id 不能为空')
  return id
}

function splitTags(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  return value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean)
}

function reminderFrom(args) {
  const reminder = {}
  if (args.mode !== undefined) reminder.mode = args.mode
  if (args.remind_at !== undefined) reminder.atLocal = args.remind_at
  if (args.remind_time !== undefined) reminder.time = args.remind_time
  if (args.lead_minutes !== undefined) reminder.leadMinutes = args.lead_minutes
  return Object.keys(reminder).length === 0 ? undefined : reminder
}

/** 把共享操作注册到一个 root Agent 上。 */
export function registerTodoTools(defineTool, api, agent) {
  return agent.ctx.tools.register(defineTool({
    name: 'todo_board',
    description: [
      '管理用户的全局待办清单（与 Web 面板同一份数据）。',
      '新建时自动补齐创建时间、提醒时间与提醒模式，可显式覆盖。',
      `action 取值：${ACTIONS.join(' / ')}。`,
      'list 返回全部条目与统计；add 新建；update 修改（只传要改的字段）；',
      'toggle 切换完成状态；remove 删除；clear_done 清除已完成；markdown 返回当前清单的 Markdown。',
    ].join(''),
    parameters: {
      action: { type: 'string', required: true, description: `操作类型：${ACTIONS.join(' / ')}` },
      title: { type: 'string', description: 'add 时的标题（必填）' },
      id: { type: 'string', description: 'update / toggle / remove 的目标 id' },
      done: { type: 'boolean', description: 'update 时的完成状态' },
      note: { type: 'string', description: '备注或 Markdown 片段' },
      mode: { type: 'string', enum: MODES, description: '提醒模式：none 不提醒 / once 一次性 / daily 每日 / lead 截止前' },
      remind_at: { type: 'string', description: '提醒时刻，本地时间 YYYY-MM-DDTHH:mm 或 ISO' },
      remind_time: { type: 'string', description: 'daily 模式的每日提醒时刻 HH:mm' },
      lead_minutes: { type: 'number', description: 'lead 模式提前的分钟数' },
      due: { type: 'string', description: '截止时间，本地时间 YYYY-MM-DDTHH:mm 或 ISO' },
      priority: { type: 'string', enum: PRIORITIES },
      tags: { type: 'string', description: '标签，逗号分隔' },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      if (exec.agent !== agent || exec.signal.aborted) return plain({ ok: false, code: 'cancelled' })
      try {
        switch (args.action) {
          case 'list':
            return plain({ ok: true, ...api.snapshot() })
          case 'markdown':
            return plain({ ok: true, markdown: api.markdown() })
          case 'add': {
            const reminder = reminderFrom(args)
            const todo = api.create({
              title: args.title,
              note: args.note,
              mode: args.mode,
              remindAt: args.remind_at,
              remindTime: args.remind_time,
              leadMinutes: args.lead_minutes,
              due: args.due,
              priority: args.priority,
              tags: splitTags(args.tags),
            })
            if (reminder !== undefined) api.update(todo.id, { reminder })
            return plain({ ok: true, todo: api.view(todo.id) })
          }
          case 'update': {
            const patch = {}
            if (args.title !== undefined) patch.title = args.title
            if (args.note !== undefined) patch.note = args.note
            if (args.done !== undefined) patch.done = args.done
            if (args.due !== undefined) patch.dueLocal = args.due
            if (args.priority !== undefined) patch.priority = args.priority
            const tags = splitTags(args.tags)
            if (tags !== undefined) patch.tags = tags
            const reminder = reminderFrom(args)
            if (reminder !== undefined) patch.reminder = reminder
            if (Object.keys(patch).length === 0) throw new Error('update 至少需要一个要修改的字段')
            return plain({ ok: true, todo: api.view(api.update(requireId(args), patch).id) })
          }
          case 'toggle':
            return plain({ ok: true, todo: api.view(api.toggle(requireId(args)).id) })
          case 'remove':
            return plain({ ok: true, removed: api.remove(requireId(args)) })
          case 'clear_done':
            return plain({ ok: true, removed: api.clearCompleted() })
          default:
            throw new Error(`action 必须是 ${ACTIONS.join(' / ')} 之一`)
        }
      } catch (error) {
        if (exec.signal.aborted) return plain({ ok: false, code: 'cancelled' })
        return plain({
          ok: false,
          code: 'todo_error',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `待办：${args.action}`,
      kind: args.action === 'list' || args.action === 'markdown' ? 'read' : 'other',
      ...(args.title === undefined ? {} : { rawInput: args.title }),
    }),
  }))
}