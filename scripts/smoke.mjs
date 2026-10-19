/**
 * 纯逻辑自检：不依赖 DSH 运行时，直接验证 store.js 与 markdown.js。
 * 运行：node scripts/smoke.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseMarkdown, renderMarkdown } from '../markdown.js'
import { formatDateTime, nextReminderAt, TodoStore, viewTodo } from '../store.js'

let passed = 0
async function check(label, run) {
  await run()
  passed += 1
  console.log(`  ok  ${label}`)
}

const directory = await mkdtemp(join(tmpdir(), 'dsh-todo-smoke-'))
const file = join(directory, 'state.json')
const makeStore = () => new TodoStore({ file, reminderMode: 'once', reminderDelayMinutes: 60, reminderGranularityMinutes: 5, leadMinutes: 10, reminderTime: '09:00' })

try {
  console.log('创建时自动补齐时间 / 提醒时间 / 提醒模式')
  const store = makeStore()
  await store.load()

  await check('新条目的创建时间就是当前时间', () => {
    const todo = store.create({ title: '写周报' })
    assert.equal(formatDateTime(todo.createdAt), formatDateTime(new Date()))
    assert.equal(todo.reminder.mode, 'once')
  })

  await check('默认提醒时间 = 现在 + 60 分钟，并向上取整到 5 分钟', () => {
    const todo = store.create({ title: '写周报' })
    const at = new Date(todo.reminder.at).getTime()
    const now = Date.now()
    assert.ok(at > now + 55 * 60_000 && at <= now + 65 * 60_000, `实际 ${formatDateTime(todo.reminder.at)}`)
    assert.equal(at % (5 * 60_000), 0, '提醒时刻未对齐 5 分钟刻度')
    assert.equal(todo.dueAt, todo.reminder.at, 'once 模式下截止时间应与提醒时刻同源')
  })

  await check('显式给出的提醒时间与模式覆盖默认值', () => {
    const todo = store.create({ title: '喝水', mode: 'daily', remindTime: '08:30' })
    assert.equal(todo.reminder.mode, 'daily')
    assert.equal(todo.reminder.time, '08:30')
    assert.equal(todo.reminder.at, null)
    assert.equal(todo.dueAt, null)
  })

  await check('lead 模式的下次提醒 = 截止时间减提前量', () => {
    const todo = store.create({ title: '交报告', mode: 'lead', due: '2026-10-20T18:00', leadMinutes: 30 })
    assert.equal(todo.reminder.mode, 'lead')
    assert.equal(todo.reminder.leadMinutes, 30)
    assert.equal(formatDateTime(nextReminderAt(todo, new Date())), '2026-10-20 17:30')
  })

  await check('none 模式没有提醒', () => {
    const todo = store.create({ title: '读书', mode: 'none' })
    assert.equal(nextReminderAt(todo, new Date()), null)
  })

  await check('切换到 once 但清空提醒时间时会补一个默认值', () => {
    const todo = store.create({ title: '改模式', mode: 'daily', remindTime: '07:00' })
    const updated = store.update(todo.id, { reminder: { mode: 'once', atLocal: '' } })
    assert.equal(updated.reminder.mode, 'once')
    assert.ok(updated.reminder.at !== null, '应当回填一个提醒时刻')
  })

  await check('切换到 daily 但没给时刻时补默认时刻', () => {
    const todo = store.create({ title: '改模式2', mode: 'none' })
    const updated = store.update(todo.id, { reminder: { mode: 'daily' } })
    assert.equal(updated.reminder.time, '09:00')
  })

  console.log('完成状态与提醒扫描')
  await check('勾选完成后不再产生提醒', () => {
    const todo = store.create({ title: '完成项' })
    store.setDone(todo.id, true)
    const view = viewTodo(store.find(todo.id), new Date())
    assert.equal(view.done, true)
    assert.equal(view.reminderState, 'none')
    assert.equal(view.nextReminderAt, null)
  })

  await check('到期提醒被扫描一次后转为 fired，不重复触发', () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    const todo = store.create({ title: '过期提醒', remindAt: past })
    const first = store.sweepReminders(new Date())
    const second = store.sweepReminders(new Date())
    assert.equal(first.length, 1)
    assert.equal(first[0].id, todo.id)
    assert.deepEqual(second, [], '已提醒的条目不应再次触发')
    assert.equal(viewTodo(store.find(todo.id), new Date()).reminderState, 'fired')
  })

  console.log('Markdown 双向转换')
  await check('生成的 Markdown 再次解析后保持一致', () => {
    const round = makeStore()
    round.create({ title: '写周报', note: '先补数据\n再写正文', mode: 'once', due: '2026-10-21T10:00', priority: 'high', tags: ['写作'] })
    round.create({ title: '喝水', mode: 'daily', remindTime: '08:30' })
    round.create({ title: '交报告', mode: 'lead', due: '2026-10-22T18:00', leadMinutes: 45 })
    round.create({ title: '读书', mode: 'none' })
    const done = round.create({ title: '修 bug' })
    round.setDone(done.id, true)

    const text = renderMarkdown(round.snapshot(), 'zh')
    assert.match(text, /- \[x\] 修 bug/)
    assert.match(text, /⏰ 每日 08:30/)
    assert.match(text, /⏰ 提前 45 分钟/)

    const parsed = parseMarkdown(text, round.list())
    assert.deepEqual(parsed.map((todo) => todo.title), round.list().map((todo) => todo.title))
    assert.deepEqual(parsed.map((todo) => todo.done), round.list().map((todo) => todo.done))
    assert.deepEqual(parsed.map((todo) => todo.reminder.mode), round.list().map((todo) => todo.reminder.mode))
    assert.deepEqual(parsed.map((todo) => todo.note), round.list().map((todo) => todo.note))
    assert.deepEqual(parsed.map((todo) => todo.dueAt), round.list().map((todo) => todo.dueAt))
    assert.deepEqual(parsed.map((todo) => todo.reminder.time), round.list().map((todo) => todo.reminder.time))
    assert.deepEqual(parsed.map((todo) => todo.reminder.leadMinutes), round.list().map((todo) => todo.reminder.leadMinutes))
  })

  await check('英文 Markdown 也能被解析回来', () => {
    const text = renderMarkdown(store.snapshot(), 'en')
    const parsed = parseMarkdown(text, [])
    assert.ok(parsed.length > 0)
    assert.ok(parsed.every((todo) => todo.title !== ''))
  })

  await check('勾掉一个复选框再保存不会丢 id 和备注', () => {
    const source = makeStore()
    const target = makeStore()
    target.create({ title: '保留备注', note: '这行不能丢' })
    const text = renderMarkdown(source.snapshot(), 'zh')
    void text
    const edited = renderMarkdown(target.snapshot(), 'zh').replace('- [ ] 保留备注', '- [x] 保留备注')
    const parsed = parseMarkdown(edited, target.list())
    assert.equal(parsed[0].done, true)
    assert.equal(parsed[0].id, target.list()[0].id)
    assert.equal(parsed[0].note, '这行不能丢')
  })

  console.log('持久化')
  await check('落盘后重新读取得到同一份清单', async () => {
    const before = store.snapshot()
    await store.flush()
    const raw = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(raw.version, 1)
    const reloaded = makeStore()
    await reloaded.load()
    assert.deepEqual(reloaded.snapshot().todos.map((todo) => todo.id), before.todos.map((todo) => todo.id))
    assert.deepEqual(reloaded.snapshot().counts, before.counts)
  })

  await check('损坏的状态文件不会阻塞启动', async () => {
    const broken = new TodoStore({ file: join(directory, 'broken.json') })
    await broken.load()
    assert.deepEqual(broken.list(), [])
  })

  console.log(`\n${passed} 项通过`)
} finally {
  await rm(directory, { recursive: true, force: true })
}