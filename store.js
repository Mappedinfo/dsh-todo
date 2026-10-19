/**
 * 待办数据模型：归一化、提醒时间计算与 JSON 持久化。
 *
 * 所有时间运算都留在 Host：Client 只回传本地时间字符串，因此
 * `<input type="datetime-local">` 之类的控件不需要在两侧各写一份时区换算。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 提醒模式：不提醒 / 一次性 / 每日 / 截止前。 */
export const REMINDER_MODES = ['none', 'once', 'daily', 'lead']
export const PRIORITIES = ['low', 'normal', 'high']

const STATE_VERSION = 1
const WRITE_DEBOUNCE_MS = 200

const pad2 = (n) => String(n).padStart(2, '0')

/** 'YYYY-MM-DD HH:mm'，面板与工具共用的人类可读本地时间。 */
export function formatDateTime(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** '<input type="datetime-local">' 的取值形式 'YYYY-MM-DDTHH:mm'。 */
export function toInputDateTime(value) {
  return value == null ? '' : formatDateTime(value).replace(' ', 'T')
}

/** '<input type="time">' 的取值形式 'HH:mm'。 */
export function toInputTime(value) {
  if (typeof value !== 'string') return ''
  const match = /^(\d{2}):(\d{2})/.exec(value)
  return match ? `${match[1]}:${match[2]}` : ''
}

/** 解析本地时间字符串，返回 Date；无法解析时返回 null。 */
export function parseLocalDateTime(text) {
  if (typeof text !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(text.trim())
  if (!match) return null
  const [, y, mo, d, h, mi] = match
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), 0, 0)
  return Number.isNaN(date.getTime()) ? null : date
}

/** 解析 'HH:mm'；无法解析时返回 null。 */
export function parseLocalTime(text) {
  if (typeof text !== 'string') return null
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return { hours, minutes }
}

/** 把秒数向上取整到最近的整步，步长 <= 1 时原样返回。 */
function ceilToGranularity(date, stepMinutes) {
  const step = Math.max(1, Math.floor(stepMinutes)) * 60_000
  const ms = date.getTime()
  return new Date(Math.ceil(ms / step) * step)
}

function clampInteger(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback
}

function asTrimmedString(value, max = 400) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

let idCounter = 0
/** 会话内单调递增，避免依赖随机数带来的可读性问题。 */
function newId(now) {
  idCounter += 1
  return `t${now.getTime().toString(36)}${idCounter.toString(36)}`
}

/** 单条待办的提醒对象，缺省补齐。 */
function normalizeReminder(raw, fallbackMode) {
  const reminder = raw !== null && typeof raw === 'object' ? raw : {}
  const mode = oneOf(reminder.mode, REMINDER_MODES, fallbackMode)
  const at = typeof reminder.at === 'string' ? reminder.at : null
  const time = typeof reminder.time === 'string' ? reminder.time : null
  return {
    mode,
    at: at !== null && !Number.isNaN(new Date(at).getTime()) ? at : null,
    time: parseLocalTime(time) !== null ? time : null,
    leadMinutes: clampInteger(reminder.leadMinutes, 0, 7 * 24 * 60, 10),
  }
}

function normalizeTodo(raw, fallbackMode, fallbackLeadMinutes) {
  if (raw === null || typeof raw !== 'object') return undefined
  const title = asTrimmedString(raw.title)
  if (title === '') return undefined
  const now = new Date().toISOString()
  const createdAt = typeof raw.createdAt === 'string' && !Number.isNaN(new Date(raw.createdAt).getTime())
    ? raw.createdAt
    : now
  const done = raw.done === true
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : newId(new Date(createdAt)),
    title,
    note: typeof raw.note === 'string' ? raw.note.slice(0, 8000) : '',
    done,
    createdAt,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : createdAt,
    completedAt: typeof raw.completedAt === 'string' ? raw.completedAt : null,
    dueAt: typeof raw.dueAt === 'string' && !Number.isNaN(new Date(raw.dueAt).getTime()) ? raw.dueAt : null,
    reminder: normalizeReminder(raw.reminder, fallbackMode),
    priority: oneOf(raw.priority, PRIORITIES, 'normal'),
    tags: Array.isArray(raw.tags)
      ? raw.tags.filter((tag) => typeof tag === 'string').map((tag) => tag.trim().slice(0, 24)).filter(Boolean).slice(0, 8)
      : [],
    remindedAt: typeof raw.remindedAt === 'string' ? raw.remindedAt : null,
    order: Number.isFinite(raw.order) ? raw.order : 0,
  }
}

/**
 * 下一次提醒时刻；null 表示当前不提醒。
 * once 用 `at`，lead 取截止时刻减提前量，daily 取下一个本地 HH:mm。
 */
export function nextReminderAt(todo, now) {
  const reminder = todo.reminder
  if (reminder.mode === 'none') return null
  if (reminder.mode === 'daily') {
    const parsed = parseLocalTime(reminder.time)
    if (parsed === null) return null
    const next = new Date(now)
    next.setHours(parsed.hours, parsed.minutes, 0, 0)
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
    return next.toISOString()
  }
  if (reminder.mode === 'lead') {
    if (todo.dueAt === null) return reminder.at
    return new Date(new Date(todo.dueAt).getTime() - reminder.leadMinutes * 60_000).toISOString()
  }
  return reminder.at
}

/** 提醒状态：none / scheduled / due / fired。 */
export function reminderState(todo, now) {
  if (todo.done) return 'none'
  const next = nextReminderAt(todo, now)
  if (next === null) return 'none'
  const at = new Date(next).getTime()
  if (at > now.getTime()) return 'scheduled'
  return todo.remindedAt !== null ? 'fired' : 'due'
}

/** 是否是本地当天。 */
function isSameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate()
}

/** 面板视图模型：补齐本地时间字符串与提醒派生状态。 */
export function viewTodo(todo, now) {
  const next = todo.done ? null : nextReminderAt(todo, now)
  const nextDate = next === null ? null : new Date(next)
  const dueDate = todo.dueAt === null ? null : new Date(todo.dueAt)
  const state = reminderState(todo, now)
  return {
    ...todo,
    createdLocal: formatDateTime(todo.createdAt),
    updatedLocal: formatDateTime(todo.updatedAt),
    dueLocal: dueDate === null ? '' : formatDateTime(dueDate),
    dueInput: toInputDateTime(dueDate),
    dueToday: dueDate !== null && !todo.done && isSameLocalDay(dueDate, now),
    overdue: dueDate !== null && !todo.done && dueDate.getTime() < now.getTime(),
    nextReminderAt: next,
    nextReminderLocal: nextDate === null ? '' : formatDateTime(nextDate),
    nextReminderInput: toInputDateTime(nextDate),
    remindTimeInput: toInputTime(todo.reminder.time),
    reminderState: state,
  }
}

/**
 * 全局待办存储。写入合并到短延迟队列，磁盘上永远是最近一次完整快照
 * （临时文件 + rename，避免半截文件）。
 */
export class TodoStore {
  constructor(options = {}) {
    this.file = options.file ?? join(homedir(), '.dsh', 'dsh-todo', 'state.json')
    this.defaults = {
      reminderMode: oneOf(options.reminderMode, REMINDER_MODES, 'once'),
      reminderDelayMinutes: clampInteger(options.reminderDelayMinutes, 1, 30 * 24 * 60, 60),
      reminderTime: parseLocalTime(options.reminderTime) === null ? '09:00' : toInputTime(options.reminderTime),
      reminderGranularityMinutes: clampInteger(options.reminderGranularityMinutes, 0, 120, 5),
      leadMinutes: clampInteger(options.leadMinutes, 0, 7 * 24 * 60, 10),
    }
    this.state = { version: STATE_VERSION, todos: [], prefs: { view: 'list', filter: 'all' } }
    this.writeTimer = null
    this.writing = Promise.resolve()
  }

  /** 读盘；文件缺失或损坏时回落到空清单，不阻塞宿主启动。 */
  async load() {
    let raw
    try {
      raw = JSON.parse(await readFile(this.file, 'utf8'))
    } catch {
      return this.state
    }
    if (raw === null || typeof raw !== 'object') return this.state
    const todos = Array.isArray(raw.todos)
      ? raw.todos
        .map((todo) => normalizeTodo(todo, this.defaults.reminderMode, this.defaults.leadMinutes))
        .filter((todo) => todo !== undefined)
      : []
    todos.sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
    todos.forEach((todo, index) => { todo.order = index })
    const prefs = raw.prefs !== null && typeof raw.prefs === 'object' ? raw.prefs : {}
    this.state = {
      version: STATE_VERSION,
      todos,
      prefs: {
        view: oneOf(prefs.view, ['list', 'markdown'], 'list'),
        filter: oneOf(prefs.filter, ['all', 'open', 'today', 'done'], 'all'),
      },
    }
    return this.state
  }

  /** 合并写盘；返回的 Promise 在本次落盘完成后兑现。 */
  flush() {
    if (this.writeTimer !== null) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    const snapshot = JSON.stringify(this.state, null, 2)
    this.writing = this.writing.then(async () => {
      const temporary = `${this.file}.tmp`
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(temporary, `${snapshot}\n`, 'utf8')
      await rename(temporary, this.file)
    }).catch(() => { /* 落盘失败不打断交互，下一次变更会重试 */ })
    return this.writing
  }

  /** 变更后排队落盘，避免连续输入时反复写文件。 */
  schedule() {
    if (this.writeTimer !== null) return
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      void this.flush()
    }, WRITE_DEBOUNCE_MS)
  }

  list() {
    return this.state.todos
  }

  find(id) {
    return this.state.todos.find((todo) => todo.id === id)
  }

  prefs() {
    return { ...this.state.prefs }
  }

  setPrefs(patch) {
    if (patch !== null && typeof patch === 'object') {
      if (patch.view !== undefined) this.state.prefs.view = oneOf(patch.view, ['list', 'markdown'], this.state.prefs.view)
      if (patch.filter !== undefined) this.state.prefs.filter = oneOf(patch.filter, ['all', 'open', 'today', 'done'], this.state.prefs.filter)
    }
    this.schedule()
    return this.prefs()
  }

  /**
   * 新建待办，并按配置自动补齐创建时间、提醒时间与提醒模式。
   * 这是"待办列表状态下自动创建时间/提醒时间/提醒模式"的唯一入口：
   * 列表视图与 agent 工具都走这里，保证两条路径产出相同。
   */
  create(input = {}) {
    const now = new Date()
    const title = asTrimmedString(input.title, 200)
    if (title === '') throw new Error('标题不能为空')

    const mode = oneOf(input.mode ?? input.reminderMode, REMINDER_MODES, this.defaults.reminderMode)
    const leadMinutes = clampInteger(
      input.leadMinutes ?? input.reminderLeadMinutes,
      0,
      7 * 24 * 60,
      this.defaults.leadMinutes,
    )
    const dailyTime = parseLocalTime(input.remindTime ?? this.defaults.reminderTime)
    /** 默认提醒时刻：现在 + 默认提前量，向上取整到配置的刻度。 */
    const defaultAt = () => {
      const base = new Date(now.getTime() + this.defaults.reminderDelayMinutes * 60_000)
      return this.defaults.reminderGranularityMinutes > 0
        ? ceilToGranularity(base, this.defaults.reminderGranularityMinutes)
        : base
    }

    // 每个模式只保留自己需要的字段：
    // once 用 at；daily 用 time；lead 用 dueAt 减提前量；none 都不用。
    // 留下不属于该模式的字段会变成死数据，切回 once 时还会被误当成旧时间复用。
    let at = parseLocalDateTime(input.remindAt ?? input.remindAtLocal)
    let due = parseLocalDateTime(input.due ?? input.dueLocal)
    if (mode === 'once') {
      if (at === null) at = defaultAt()
      if (due === null) due = at
    } else if (mode === 'lead') {
      at = null
      if (due === null) due = defaultAt()
    } else {
      at = null
    }

    const todo = {
      id: newId(now),
      title,
      note: typeof input.note === 'string' ? input.note.slice(0, 8000) : '',
      done: input.done === true,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      completedAt: input.done === true ? now.toISOString() : null,
      dueAt: due === null ? null : due.toISOString(),
      reminder: {
        mode,
        at: at === null ? null : at.toISOString(),
        // 只有 daily 模式才需要每日时刻；其余模式留空，Markdown 往返才不会带出无意义字段。
        time: mode === 'daily' && dailyTime !== null ? `${pad2(dailyTime.hours)}:${pad2(dailyTime.minutes)}` : null,
        leadMinutes,
      },
      priority: oneOf(input.priority, PRIORITIES, 'normal'),
      tags: Array.isArray(input.tags)
        ? input.tags.filter((tag) => typeof tag === 'string').map((tag) => tag.trim().slice(0, 24)).filter(Boolean).slice(0, 8)
        : [],
      remindedAt: null,
      order: this.state.todos.length,
    }
    this.state.todos.push(todo)
    this.schedule()
    return todo
  }

  /** 局部更新。`remindAtLocal` / `dueLocal` 接受本地时间字符串。 */
  update(id, patch = {}) {
    const todo = this.find(id)
    if (todo === undefined) throw new Error(`待办不存在：${id}`)
    if (typeof patch.title === 'string') {
      const title = patch.title.trim().slice(0, 200)
      if (title === '') throw new Error('标题不能为空')
      todo.title = title
    }
    if (typeof patch.note === 'string') todo.note = patch.note.slice(0, 8000)
    if (typeof patch.priority === 'string') todo.priority = oneOf(patch.priority, PRIORITIES, todo.priority)
    if (Array.isArray(patch.tags)) {
      todo.tags = patch.tags
        .filter((tag) => typeof tag === 'string')
        .map((tag) => tag.trim().slice(0, 24))
        .filter(Boolean)
        .slice(0, 8)
    }
    if (patch.done !== undefined) this.setDone(id, patch.done === true)
    if (patch.due !== undefined || patch.dueLocal !== undefined) {
      const text = patch.dueLocal ?? patch.due
      if (text === null || text === '') todo.dueAt = null
      else {
        const parsed = parseLocalDateTime(text)
        if (parsed === null) throw new Error('截止时间格式应为 YYYY-MM-DDTHH:mm')
        todo.dueAt = parsed.toISOString()
      }
    }
    if (patch.reminder !== undefined && patch.reminder !== null && typeof patch.reminder === 'object') {
      const reminder = patch.reminder
      const nextMode = oneOf(reminder.mode, REMINDER_MODES, todo.reminder.mode)
      const previousMode = todo.reminder.mode
      todo.reminder = {
        mode: nextMode,
        at: todo.reminder.at,
        time: todo.reminder.time,
        leadMinutes: clampInteger(reminder.leadMinutes, 0, 7 * 24 * 60, todo.reminder.leadMinutes),
      }
      // 切换模式时补齐该模式需要的字段，避免出现"选了每日但没有时刻"。
      if (reminder.time !== undefined) {
        const parsed = parseLocalTime(reminder.time)
        todo.reminder.time = parsed === null ? null : `${pad2(parsed.hours)}:${pad2(parsed.minutes)}`
      }
      if (nextMode === 'daily' && todo.reminder.time === null) {
        todo.reminder.time = this.defaults.reminderTime
      }
      if (reminder.at !== undefined || reminder.atLocal !== undefined) {
        const text = reminder.atLocal ?? reminder.at
        if (text === null || text === '') todo.reminder.at = null
        else {
          const parsed = parseLocalDateTime(text)
          if (parsed === null) throw new Error('提醒时间格式应为 YYYY-MM-DDTHH:mm')
          todo.reminder.at = parsed.toISOString()
        }
      }
      // 只有 once 用 at；切到其他模式时清掉，避免死字段在切回 once 时被当成旧时间复用。
      if (nextMode === 'once') {
        if (todo.reminder.at === null) {
          const fallback = new Date(Date.now() + this.defaults.reminderDelayMinutes * 60_000)
          todo.reminder.at = (this.defaults.reminderGranularityMinutes > 0
            ? ceilToGranularity(fallback, this.defaults.reminderGranularityMinutes)
            : fallback).toISOString()
        }
      } else {
        todo.reminder.at = null
      }
      if (nextMode !== 'daily') todo.reminder.time = null
      // lead 需要截止时间才提醒得到；没有就补一个，否则该条目永远不会触发。
      if (nextMode === 'lead' && todo.dueAt === null) {
        const fallback = new Date(Date.now() + this.defaults.reminderDelayMinutes * 60_000)
        todo.dueAt = (this.defaults.reminderGranularityMinutes > 0
          ? ceilToGranularity(fallback, this.defaults.reminderGranularityMinutes)
          : fallback).toISOString()
      }
      if (previousMode !== nextMode) todo.remindedAt = null
    }
    todo.updatedAt = new Date().toISOString()
    this.schedule()
    return todo
  }

  setDone(id, done) {
    const todo = this.find(id)
    if (todo === undefined) throw new Error(`待办不存在：${id}`)
    if (todo.done === done) return todo
    todo.done = done
    todo.updatedAt = new Date().toISOString()
    todo.completedAt = done ? todo.updatedAt : null
    // 重新打开时重新武装提醒，避免沿用上次已触发的时间戳。
    if (!done) todo.remindedAt = null
    this.schedule()
    return todo
  }

  toggle(id) {
    const todo = this.find(id)
    if (todo === undefined) throw new Error(`待办不存在：${id}`)
    return this.setDone(id, !todo.done)
  }

  remove(id) {
    const index = this.state.todos.findIndex((todo) => todo.id === id)
    if (index < 0) return false
    this.state.todos.splice(index, 1)
    this.state.todos.forEach((todo, position) => { todo.order = position })
    this.schedule()
    return true
  }

  reorder(ids) {
    if (!Array.isArray(ids)) return
    const position = new Map(ids.map((id, index) => [id, index]))
    this.state.todos.sort((a, b) => {
      const left = position.has(a.id) ? position.get(a.id) : Number.MAX_SAFE_INTEGER
      const right = position.has(b.id) ? position.get(b.id) : Number.MAX_SAFE_INTEGER
      return left - right || a.order - b.order
    })
    this.state.todos.forEach((todo, index) => { todo.order = index })
    this.schedule()
  }

  clearCompleted() {
    const before = this.state.todos.length
    this.state.todos = this.state.todos.filter((todo) => !todo.done)
    this.state.todos.forEach((todo, index) => { todo.order = index })
    this.schedule()
    return before - this.state.todos.length
  }

  /** 整表替换，供 Markdown 视图的"保存"使用。 */
  replaceAll(todos) {
    this.state.todos = todos
      .map((todo) => normalizeTodo(todo, this.defaults.reminderMode, this.defaults.leadMinutes))
      .filter((todo) => todo !== undefined)
    this.state.todos.forEach((todo, index) => { todo.order = index })
    this.schedule()
    return this.state.todos
  }

  /**
   * 扫描到期提醒并记账。只改 Host 侧状态，面板据此显示"已提醒"，
   * 不代替用户做任何操作。
   */
  sweepReminders(now = new Date()) {
    const due = []
    for (const todo of this.state.todos) {
      if (todo.done || reminderState(todo, now) !== 'due') continue
      todo.remindedAt = now.toISOString()
      todo.updatedAt = todo.remindedAt
      due.push(todo)
    }
    if (due.length > 0) this.schedule()
    return due
  }

  /** 面板与工具共用的完整快照。 */
  snapshot(now = new Date()) {
    const todos = this.list().map((todo) => viewTodo(todo, now))
    return {
      todos,
      prefs: this.prefs(),
      counts: {
        total: todos.length,
        open: todos.filter((todo) => !todo.done).length,
        done: todos.filter((todo) => todo.done).length,
        today: todos.filter((todo) => todo.dueToday).length,
        due: todos.filter((todo) => todo.reminderState === 'due').length,
      },
      defaults: { ...this.defaults },
      serverTime: now.toISOString(),
      serverTimeLocal: formatDateTime(now),
    }
  }
}