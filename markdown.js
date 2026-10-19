/**
 * Markdown 视图的生成与解析。
 *
 * 生成与解析放在 Host，Client 只渲染取回的文本：这样列表视图与
 * Markdown 视图共用同一份时间与提醒逻辑，两边不会漂移。
 * 生成的行保持人类可读，同时每段元数据以固定前缀标注，解析可无损还原。
 */
import { formatDateTime, nextReminderAt, parseLocalDateTime, parseLocalTime } from './store.js'

/** 两种语言的行内标记；解析时两种都接受。 */
const LABELS = {
  zh: {
    title: '待办清单',
    summary: (c) => `共 ${c.total} 项 · 未完成 ${c.open} · 今日到期 ${c.today}`,
    open: '待办',
    done: '已完成',
    empty: '（空）',
    none: '无提醒',
    once: '一次性',
    daily: '每日',
    lead: '提前',
    at: '提醒于',
    due: '截止',
    priority: '优先级',
    completedAt: '完成于',
    dailyAt: '每日',
    leadBy: '提前',
    minutes: '分钟',
    priorities: { low: '低', normal: '普通', high: '高' },
  },
  en: {
    title: 'Todo List',
    summary: (c) => `${c.total} total · ${c.open} open · ${c.today} due today`,
    open: 'Open',
    done: 'Done',
    empty: '(empty)',
    none: 'no reminder',
    once: 'once',
    daily: 'daily',
    lead: 'lead',
    at: 'remind at',
    due: 'due',
    priority: 'priority',
    completedAt: 'completed',
    dailyAt: 'daily',
    leadBy: 'lead',
    minutes: 'min',
    priorities: { low: 'low', normal: 'normal', high: 'high' },
  },
}

const SEPARATOR = ' · '

function resolveLocale(locale) {
  return typeof locale === 'string' && locale.toLowerCase().startsWith('en') ? 'en' : 'zh'
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

/** 单条待办的元数据片段。 */
function segments(todo, labels) {
  const parts = []
  const reminder = todo.reminder

  // 提醒片段对已完成条目同样输出：否则 Markdown 往返一次就会丢掉提醒模式。
  if (reminder.mode === 'none') {
    parts.push(`⏰ ${labels.none}`)
  } else if (reminder.mode === 'daily') {
    parts.push(`⏰ ${labels.dailyAt} ${reminder.time ?? '09:00'}`)
    parts.push(labels.daily)
  } else if (reminder.mode === 'lead') {
    parts.push(`⏰ ${labels.leadBy} ${reminder.leadMinutes} ${labels.minutes}`)
    parts.push(labels.lead)
  } else {
    const next = nextReminderAt(todo, new Date())
    parts.push(`⏰ ${next === null ? labels.none : formatDateTime(next)}`)
    parts.push(labels.once)
  }

  if (todo.done) {
    if (todo.completedAt !== null) parts.push(`${labels.completedAt} ${formatDateTime(todo.completedAt)}`)
    if (todo.dueAt !== null) parts.push(`${labels.due} ${formatDateTime(todo.dueAt)}`)
    if (todo.priority !== 'normal') parts.push(`${labels.priority} ${labels.priorities[todo.priority] ?? todo.priority}`)
    for (const tag of todo.tags) parts.push(`#${tag}`)
    return parts
  }

  if (todo.dueAt !== null) parts.push(`${labels.due} ${formatDateTime(todo.dueAt)}`)
  if (todo.priority !== 'normal') parts.push(`${labels.priority} ${labels.priorities[todo.priority] ?? todo.priority}`)
  for (const tag of todo.tags) parts.push(`#${tag}`)
  return parts
}

function itemLine(todo, labels) {
  const box = todo.done ? '[x]' : '[ ]'
  return `- ${box} ${todo.title}${segments(todo, labels).length > 0 ? SEPARATOR + segments(todo, labels).join(SEPARATOR) : ''}`
}

function section(heading, todos, labels) {
  const lines = [`## ${heading}`, '']
  if (todos.length === 0) {
    lines.push(labels.empty, '')
    return lines
  }
  for (const todo of todos) {
    lines.push(itemLine(todo, labels))
    if (todo.note.trim() !== '') {
      for (const line of todo.note.trim().split('\n')) lines.push(`      ${line}`)
    }
  }
  lines.push('')
  return lines
}

/** 由快照生成 Markdown 文本。 */
export function renderMarkdown(snapshot, locale) {
  const labels = LABELS[resolveLocale(locale)]
  const todos = snapshot.todos
  const open = todos.filter((todo) => !todo.done)
  const done = todos.filter((todo) => todo.done)
  return [
    `# ${labels.title}`,
    '',
    `> ${labels.summary(snapshot.counts)}`,
    '',
    ...section(labels.open, open, labels),
    ...section(labels.done, done, labels),
  ].join('\n').replace(/\n+$/, '\n')
}

const ALL_LABELS = Object.values(LABELS)
const MODE_BY_TOKEN = new Map()
const PRIORITY_BY_TOKEN = new Map()
for (const entry of ALL_LABELS) {
  MODE_BY_TOKEN.set(entry.none, 'none')
  MODE_BY_TOKEN.set(entry.once, 'once')
  MODE_BY_TOKEN.set(entry.daily, 'daily')
  MODE_BY_TOKEN.set(entry.lead, 'lead')
  for (const [key, text] of Object.entries(entry.priorities)) PRIORITY_BY_TOKEN.set(text, key)
}

function splitSegments(text) {
  return text.split(SEPARATOR).map((part) => part.trim())
}

/**
 * 解析 Markdown 文本为待办数组。
 * 未写进文本的字段沿用 `previous` 中同序同标题的旧条目，因此
 * "只勾掉一个复选框再保存" 不会丢掉 id 和备注。
 */
export function parseMarkdown(text, previous = []) {
  if (typeof text !== 'string') throw new Error('markdown 必须是字符串')
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const results = []
  let done = false
  let pending = null
  const taken = new Set()

  const reuse = (item) => {
    const index = previous.findIndex((todo, position) => !taken.has(position) && todo.title === item.title)
    if (index < 0) return item
    taken.add(index)
    const old = previous[index]
    return {
      ...item,
      id: old.id,
      createdAt: old.createdAt,
      note: item.note !== '' ? item.note : old.note,
      tags: item.tags.length > 0 ? item.tags : old.tags,
      priority: item.prioritySet ? item.priority : old.priority,
      // 文本里没写提醒模式时沿用旧值，避免"只勾了复选框"就丢掉提醒设置。
      reminder: item.reminder.mode === null ? old.reminder : item.reminder,
    }
  }

  const commit = () => {
    if (pending === null) return
    results.push(reuse(pending))
    pending = null
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '')

    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading !== null) {
      const text_ = heading[1].trim()
      const lowered = text_.toLowerCase()
      if (LABELS.zh.open === text_ || LABELS.en.open.toLowerCase() === lowered) done = false
      else if (LABELS.zh.done === text_ || LABELS.en.done.toLowerCase() === lowered) done = true
      commit()
      continue
    }
    if (line.trim() === '') {
      commit()
      continue
    }

    // 备注续行：列表项之后缩进的普通文本。
    if (pending !== null && /^\s{2,}\S/.test(rawLine)) {
      pending.note = pending.note === '' ? rawLine.trim() : `${pending.note}\n${rawLine.trim()}`
      continue
    }

    const item = /^[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line)
    if (item === null) {
      commit()
      continue
    }
    commit()

    const checked = item[1].toLowerCase() === 'x'
    const parts = splitSegments(item[2])
    const entry = {
      title: parts.shift() ?? '',
      note: '',
      done: checked,
      completedAt: null,
      dueAt: null,
      priority: 'normal',
      prioritySet: false,
      reminder: { mode: null, at: null, time: null, leadMinutes: null },
      tags: [],
    }
    for (const part of parts) {
      if (part === '') continue
      if (part.startsWith('#')) {
        entry.tags.push(part.slice(1).trim().slice(0, 24))
        continue
      }
      if (part.startsWith('⏰')) {
        const body = part.slice(1).trim()
        const daily = new RegExp(`^(?:${LABELS.zh.dailyAt}|${LABELS.en.dailyAt})\\s+(.+)$`).exec(body)
        const lead = new RegExp(`^(?:${LABELS.zh.leadBy}|${LABELS.en.leadBy})\\s+(\\d+)\\s+`).exec(body)
        if (daily !== null && parseLocalTime(daily[1]) !== null) {
          entry.reminder.mode = 'daily'
          entry.reminder.time = daily[1].trim().slice(0, 5)
        } else if (lead !== null) {
          entry.reminder.mode = 'lead'
          entry.reminder.leadMinutes = Number(lead[1])
        } else {
          const parsed = parseLocalDateTime(body)
          if (parsed !== null) {
            entry.reminder.mode = 'once'
            entry.reminder.at = parsed.toISOString()
          }
        }
        continue
      }
      const mode = MODE_BY_TOKEN.get(part)
      if (mode !== undefined) {
        entry.reminder.mode = mode
        continue
      }
      if (part.startsWith(`${LABELS.zh.due} `) || part.toLowerCase().startsWith(`${LABELS.en.due} `)) {
        const parsed = parseLocalDateTime(part.split(' ').slice(1).join(' '))
        if (parsed !== null) entry.dueAt = parsed.toISOString()
        continue
      }
      if (part.startsWith(`${LABELS.zh.at} `) || part.toLowerCase().startsWith(`${LABELS.en.at} `)) {
        const parsed = parseLocalDateTime(part.split(' ').slice(1).join(' '))
        if (parsed !== null) {
          entry.reminder.mode = 'once'
          entry.reminder.at = parsed.toISOString()
        }
        continue
      }
      if (part.startsWith(`${LABELS.zh.completedAt} `) || part.toLowerCase().startsWith(`${LABELS.en.completedAt} `)) {
        const parsed = parseLocalDateTime(part.split(' ').slice(1).join(' '))
        if (parsed !== null) entry.completedAt = parsed.toISOString()
        continue
      }
      if (part.startsWith(`${LABELS.zh.priority} `) || part.toLowerCase().startsWith(`${LABELS.en.priority} `)) {
        const value = PRIORITY_BY_TOKEN.get(part.split(' ').slice(1).join(' ').toLowerCase())
        if (value !== undefined) {
          entry.priority = value
          entry.prioritySet = true
        }
      }
    }
    if (entry.title !== '') pending = entry
  }
  commit()

  const now = new Date().toISOString()
  return results.map((entry) => {
    const mode = entry.reminder.mode ?? 'none'
    return {
      id: entry.id,
      title: entry.title.slice(0, 200),
      note: entry.note,
      done: entry.done,
      createdAt: entry.createdAt ?? now,
      updatedAt: now,
      completedAt: entry.done ? entry.completedAt ?? now : null,
      dueAt: entry.dueAt,
      reminder: {
        mode,
        at: entry.reminder.at,
        time: entry.reminder.time,
        leadMinutes: entry.reminder.leadMinutes ?? 10,
      },
      priority: entry.priority,
      tags: entry.tags,
      remindedAt: null,
    }
  })
}

export { LABELS as MARKDOWN_LABELS, pad2 }