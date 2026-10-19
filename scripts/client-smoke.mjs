/**
 * Client 半边自检：用桩 loader 真正执行 client.js 的 factory，
 * 验证槽位注册、语言包注册、随面板挂载的样式表，以及两种视图能否构建出元素树。
 *
 * 关键约束：桩环境**不提供** styles / host / console 等 builtin。
 * 插件 bundle 的 factory 只拿到 require，任何对 builtin 的引用都应在这里失败。
 *
 * 运行：node scripts/client-smoke.mjs
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

let passed = 0
function check(label, run) {
  run()
  passed += 1
  console.log(`  ok  ${label}`)
}

// ── 桩 React：只需 createElement 与几个 hook 的形状 ──────────────────────
const hookState = new Map()
let hookIndex = 0
const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat() }
  },
  useState(initial) {
    const key = `s${hookIndex++}`
    if (!hookState.has(key)) hookState.set(key, typeof initial === 'function' ? initial() : initial)
    return [hookState.get(key), () => {}]
  },
  useEffect() {},
  useMemo(factory) { return factory() },
  useCallback(fn) { return fn },
  useRef(initial) { return { current: initial } },
}

/** 逐层求值函数组件，得到只剩宿主元素的树。 */
function renderNode(node) {
  if (Array.isArray(node)) return node.map(renderNode)
  if (node === null || typeof node !== 'object') return node
  if (typeof node.type === 'function') return renderNode(node.type({ ...node.props }))
  return {
    type: node.type,
    props: node.props,
    children: [renderNode(node.children), renderNode(node.props?.children)].flat().filter((child) => child !== undefined),
  }
}

/** 展平整棵树；文本节点也保留，便于断言实际渲染出的文字。 */
function collectNodes(root) {
  const nodes = []
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (typeof node === 'string') return nodes.push(node)
    if (node === null || typeof node !== 'object') return
    nodes.push(node)
    walk(node.children)
  }
  walk(root)
  return nodes
}

// ── 桩 loader：接住 window.__ModuleLoader__.load ─────────────────────────
let registration = null
globalThis.window = {
  __ModuleLoader__: {
    load(row) {
      registration = row
    },
  },
}

await import(pathToFileURL(new URL('../client.js', import.meta.url).pathname).href)

check('bundle 通过 window.__ModuleLoader__.load 注册，id 与包名一致', () => {
  assert.ok(registration !== null, '没有捕获到注册')
  assert.equal(registration.id, '@mappedinfo/dsh-todo')
  assert.equal(typeof registration.factory, 'function')
})

check('factory 返回一个注入 slots/locale/connection 的插件', () => {
  const plugin = registration.factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require('${id}')`)
  })
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'connection'])
  assert.equal(typeof plugin.apply, 'function')
  globalThis.__plugin = plugin
})

// ── 桩 Client 上下文：记录注册与清理 ────────────────────────────────────
const registrations = []
let localeDict = null
const disposed = { locale: false, icon: false, panel: false }

const effectDisposers = []
const ctx = {
  effect(factory, label) {
    const dispose = factory()
    assert.equal(typeof dispose, 'function', `${label} 的 effect 没有返回清理函数`)
    effectDisposers.push(dispose)
    return dispose
  },
  locale: {
    register(namespace, dicts) {
      localeDict = { namespace, dicts }
      return () => { disposed.locale = true }
    },
    bind() {
      return (key, params) => {
        const dict = localeDict.dicts.zh
        const text = dict[key] ?? key
        return text.replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''))
      }
    },
    getLocale: () => ({ id: 'zh' }),
  },
  slots: {
    // 真实 inject 返回的释放函数会撤掉它这次回调注册的所有内容，桩必须照做。
    inject(name, callback) {
      const from = registrations.length
      callback()
      const slot = name === 'main' ? 'panel' : 'icon'
      return () => {
        disposed[slot] = true
        for (const entry of registrations.slice(from)) entry.dispose()
      }
    },
    register(options, component) {
      const entry = { options, component, dispose: () => { registrations.splice(registrations.indexOf(entry), 1) } }
      registrations.push(entry)
      return entry.dispose
    },
  },
  connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
}

const stylesBuiltin = { insert(css) { styles.push(css); return () => { disposed.styles = true } } }

check('apply 在只有 require 的 bundle 环境里注册两个槽位', () => {
  // 关键回归点：不提供 styles / host / console 等 builtin。
  // 插件 bundle 的 factory 只拿到 require，任何对 builtin 的引用都会在这里炸掉。
  globalThis.__plugin.apply(ctx)
  const names = registrations.map((entry) => `${entry.options.name}:${entry.options.id ?? entry.options.key}`)
  assert.deepEqual(names.sort(), ['main:todo', 'sidebar.panellist:todo'])
})

check('侧栏图标带 order 与本地化 label thunk', () => {
  const icon = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
  assert.equal(typeof icon.options.label, 'function')
  assert.equal(icon.options.label(), '待办清单')
})

check('语言包同时提供 zh 与 en 两套文案', () => {
  assert.equal(localeDict.namespace, 'dsh-todo')
  assert.equal(localeDict.dicts.zh.panel, '待办清单')
  assert.equal(localeDict.dicts.en.panel, 'Todo List')
  for (const key of ['viewList', 'viewMarkdown', 'modeOnce', 'createdSummary']) {
    assert.ok(localeDict.dicts.zh[key], `zh 缺少 ${key}`)
    assert.ok(localeDict.dicts.en[key], `en 缺少 ${key}`)
  }
})

check('样式表随面板挂载，且只用 --dsw-alias-* 主题令牌，不含字面色', () => {
  const panel = registrations.find((entry) => entry.options.name === 'main')
  hookState.clear()
  hookIndex = 0
  hookState.set('s0', { todos: [], prefs: { view: 'list', filter: 'all' }, counts: { total: 0, open: 0, done: 0, today: 0, due: 0 } })
  hookState.set('s1', '')
  const root = renderNode(panel.component({}))
  const style = collectNodes(root).find((node) => node.type === 'style')
  assert.ok(style !== undefined, '面板里没有 <style> 元素')
  assert.equal(style.props['data-dsh-todo'], '')
  const css = style.children[0]
  assert.ok(typeof css === 'string' && css.includes('.dsh-todo'), '样式内容不对')
  assert.ok(css.includes('--dsw-alias-'), '没有引用主题令牌')
  // 插件自定义属性必须在样式里自己声明，否则 var() 会解析成空值。
  const owned = new Set([...css.matchAll(/(--dsh-todo-[\w-]+)\s*:/g)].map((match) => match[1]))
  const referenced = [...css.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1])
  for (const name of new Set(referenced)) {
    const allowed = name.startsWith('--dsw-alias-') || name.startsWith('--dsw-specific-') || owned.has(name)
    assert.ok(allowed, `使用了未声明的非主题令牌 ${name}`)
  }
  const literals = css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g)
  assert.equal(literals, null, `样式里出现了字面颜色：${literals?.join(', ')}`)
})

check('侧栏图标组件能构建出 svg 元素', () => {
  const icon = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
  // 注册的是一层薄包装，真正的绘制在 TodoIcon 里，所以要逐层求值。
  let element = icon.component({ size: 20, active: true })
  while (typeof element.type === 'function') {
    element = element.type({ ...element.props })
  }
  assert.equal(element.type, 'svg')
  assert.equal(element.props.width, 20)
  assert.ok(element.children.length > 0)
})

check('主面板在拿到快照后能构建出列表视图', () => {
  const panel = registrations.find((entry) => entry.options.name === 'main')
  const snapshot = {
    todos: [{
      id: 'a1',
      title: '写周报',
      note: '',
      done: false,
      priority: 'high',
      tags: ['写作'],
      createdLocal: '2026-10-19 09:00',
      dueLocal: '2026-10-19 18:00',
      dueInput: '2026-10-19T18:00',
      dueToday: true,
      overdue: false,
      nextReminderLocal: '2026-10-19 17:00',
      nextReminderInput: '2026-10-19T17:00',
      remindTimeInput: '',
      reminderState: 'scheduled',
      reminder: { mode: 'once', leadMinutes: 10, time: null },
    }],
    prefs: { view: 'list', filter: 'all' },
    counts: { total: 1, open: 1, done: 0, today: 1, due: 0 },
    markdown: '# 待办清单\n\n## 待办\n\n- [ ] 写周报',
  }
  ctx.connection.rpc.call = async (_channel, endpoint) => {
    assert.equal(_channel, '/dsh-todo', 'RPC 通道名不对')
    if (endpoint === 'snapshot') return { ok: true, value: snapshot }
    return { ok: true, value: {} }
  }
  // 桩 useEffect 是空操作，快照不会自己到达；直接把首个 useState 预置成已加载状态，
  // 这样走的是和真实页面一样的「已有数据」渲染路径。
  hookState.clear()
  hookIndex = 0
  hookState.set('s0', snapshot)
  hookState.set('s1', snapshot.markdown)
  const root = renderNode(panel.component({}))
  assert.equal(root.type, 'div')
  const nodes = collectNodes(root)
  const types = nodes.map((node) => node.type)
  const texts = nodes.filter((node) => typeof node === 'string')
  assert.ok(types.includes('input'), '没有渲染新建输入框')
  assert.ok(types.includes('button'), '没有渲染按钮')
  assert.equal(types.includes('textarea'), false, '列表视图不该出现备注编辑框')
  assert.ok(texts.includes('写周报'), '没有渲染待办标题')
  assert.ok(texts.includes('列表') && texts.includes('Markdown'), '没有渲染视图切换')
  assert.ok(texts.includes('共 1 · 未完成 1 · 今日到期 1'), '没有渲染统计摘要')
})

check('切到 Markdown 视图能渲染任务项复选框，再切源码模式出现文本域', () => {
  const panel = registrations.find((entry) => entry.options.name === 'main')
  const markdownView = {
    todos: [],
    prefs: { view: 'markdown', filter: 'all' },
    counts: { total: 1, open: 1, done: 0, today: 1, due: 0 },
  }
  const text = '# 待办清单\n\n> 共 1 项 · 未完成 1 · 今日到期 1\n\n## 待办\n\n- [ ] 写周报 · ⏰ 2026-10-19 17:00 · 一次性\n\n      先补数据\n\n## 已完成\n\n（空）\n'
  const collect = (root) => {
    const nodes = collectNodes(root)
    return {
      types: nodes.map((node) => node.type),
      texts: nodes.filter((node) => typeof node === 'string'),
      buttons: nodes.filter((node) => node.type === 'button'),
    }
  }

  // 预览模式
  hookState.clear()
  hookIndex = 0
  hookState.set('s0', markdownView)
  hookState.set('s1', text)
  const preview = collect(renderNode(panel.component({})))
  assert.ok(preview.types.includes('h1'), 'Markdown 标题没有渲染')
  assert.ok(preview.types.includes('blockquote'), 'Markdown 摘要没有渲染')
  const check = preview.buttons.find((button) => button.props.role === 'checkbox')
  assert.ok(check !== undefined, '任务项复选框没有渲染')
  assert.equal(check.props['aria-checked'], 'false', '未完成任务应为未勾选')
  assert.ok(preview.texts.some((value) => value.includes('写周报')), '没有渲染任务标题')
  assert.ok(preview.texts.includes('2026-10-19 17:00 · 一次性'), '没有渲染提醒元数据')
  assert.ok(preview.texts.includes('先补数据'), '没有渲染缩进备注')
  assert.equal(preview.types.includes('textarea'), false, '预览模式不该出现文本域')

  // 源码模式。桩 hook 按调用序号取值：TodoPanel 吃掉 s0..s4（useRef 不占位），
  // MarkdownView 的 source 是 s5、preview|source 是 s6。
  hookState.clear()
  hookIndex = 0
  hookState.set('s0', markdownView)
  hookState.set('s1', text)
  hookState.set('s5', text)
  hookState.set('s6', 'source')
  const source = collect(renderNode(panel.component({})))
  assert.ok(source.types.includes('textarea'), '源码模式没有渲染文本域')
})

check('卸载会清掉语言包与两个槽位注册', () => {
  assert.equal(effectDisposers.length, 1, 'apply 应当只开一个 effect')
  for (const dispose of effectDisposers) dispose()
  assert.deepEqual(disposed, { locale: true, icon: true, panel: true })
  assert.equal(registrations.length, 0)
})

console.log(`\n${passed} 项通过`)