/**
 * dsh-todo Client 半边：侧栏面板图标 + 主区域待办面板（列表 / Markdown 双视图）。
 *
 * 面板渲染在宿主分配的 `main` 槽位里，样式只用 `--dsw-alias-*` 主题令牌，
 * 因此浅色/深色与宿主字体设置都自动跟随；不引入任何 Harness Client 包。
 */
window.__ModuleLoader__.load({
  id: '@mappedinfo/dsh-todo',
  factory(require) {
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React

    const CHANNEL = '/dsh-todo'
    const NS = 'dsh-todo'
    const REMINDER_MODES = ['none', 'once', 'daily', 'lead']
    const PRIORITIES = ['low', 'normal', 'high']
    const FILTERS = ['all', 'open', 'today', 'done']

    const ZH = {
      panel: '待办清单',
      viewList: '列表',
      viewMarkdown: 'Markdown',
      filterAll: '全部',
      filterOpen: '待办',
      filterToday: '今天',
      filterDone: '已完成',
      clearDone: '清除已完成',
      placeholder: '添加一项待办，回车保存',
      add: '添加',
      empty: '还没有待办事项',
      emptyFilter: '当前筛选下没有条目',
      created: '创建',
      remind: '提醒',
      due: '截止',
      remindAt: '提醒于',
      remindTime: '每日时刻',
      leadMinutes: '提前分钟',
      mode: '提醒模式',
      modeNone: '不提醒',
      modeOnce: '一次性',
      modeDaily: '每日',
      modeLead: '截止前',
      priority: '优先级',
      priorityLow: '低',
      priorityNormal: '普通',
      priorityHigh: '高',
      note: '备注',
      notePlaceholder: '补充说明（支持 Markdown）',
      tags: '标签',
      tagsPlaceholder: '逗号分隔',
      title: '标题',
      save: '保存',
      cancel: '取消',
      delete: '删除',
      edit: '编辑',
      done: '完成',
      preview: '预览',
      source: '源码',
      copy: '复制',
      applied: '已写回清单',
      dueBadge: '今日到期',
      overdueBadge: '已逾期',
      remindDueBadge: '待提醒',
      remindedBadge: '已提醒',
      loading: '载入中…',
      failed: '待办面板载入失败',
      createdSummary: '共 {total} · 未完成 {open} · 今日到期 {today}',
      dueNotice: '{count} 项到达提醒时间',
      backToChat: '返回对话',
      stripOpen: '待办 {open}',
      stripToday: '今日 {today}',
      stripDone: '已完成 {done}',
    }
    const EN = {
      panel: 'Todo List',
      viewList: 'List',
      viewMarkdown: 'Markdown',
      filterAll: 'All',
      filterOpen: 'Open',
      filterToday: 'Today',
      filterDone: 'Done',
      clearDone: 'Clear done',
      placeholder: 'Add a task, Enter to save',
      add: 'Add',
      empty: 'No tasks yet',
      emptyFilter: 'Nothing matches this filter',
      created: 'Created',
      remind: 'Remind',
      due: 'Due',
      remindAt: 'Remind at',
      remindTime: 'Daily time',
      leadMinutes: 'Lead minutes',
      mode: 'Reminder mode',
      modeNone: 'None',
      modeOnce: 'Once',
      modeDaily: 'Daily',
      modeLead: 'Lead',
      priority: 'Priority',
      priorityLow: 'Low',
      priorityNormal: 'Normal',
      priorityHigh: 'High',
      note: 'Note',
      notePlaceholder: 'Details (Markdown supported)',
      tags: 'Tags',
      tagsPlaceholder: 'comma separated',
      title: 'Title',
      save: 'Save',
      cancel: 'Cancel',
      delete: 'Delete',
      edit: 'Edit',
      done: 'Done',
      preview: 'Preview',
      source: 'Source',
      copy: 'Copy',
      applied: 'Written back',
      dueBadge: 'Due today',
      overdueBadge: 'Overdue',
      remindDueBadge: 'Remind now',
      remindedBadge: 'Reminded',
      loading: 'Loading…',
      failed: 'Could not load the todo board',
      createdSummary: '{total} total · {open} open · {today} due today',
      dueNotice: '{count} task(s) reached their reminder time',
      backToChat: 'Back to chat',
      stripOpen: '{open} open',
      stripToday: '{today} today',
      stripDone: '{done} done',
    }

    // ── RPC ────────────────────────────────────────────────────────────────
    // `rpc.call` 直接解码出 Host 写的 result 信封 `{ ok, value }` / `{ ok, error }`。
    function createApi(rpc, getLocale) {
      async function call(endpoint, payload) {
        const response = await rpc.call(CHANNEL, endpoint, payload ?? {})
        if (response?.ok !== true) throw new Error(response?.error?.message ?? 'request failed')
        return response.value
      }
      return {
        snapshot: () => call('snapshot', { locale: getLocale() }),
        create: (input) => call('create', { input }),
        update: (id, patch) => call('update', { id, patch }),
        toggle: (id) => call('toggle', { id }),
        remove: (id) => call('remove', { id }),
        clearCompleted: () => call('clear-completed'),
        saveMarkdown: (text) => call('save-markdown', { text, locale: getLocale() }),
        setPrefs: (patch) => call('set-prefs', { patch }),
        sweep: () => call('sweep'),
      }
    }

    // ── 最小 Markdown 渲染 ──────────────────────────────────────────────────
    // 只覆盖本插件自己生成的语法（标题、引用、任务项、列表、代码块、行内样式），
    // 因此不引入第三方 Markdown 运行时。
    function inlineNodes(text, keyPrefix) {
      const nodes = []
      const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*|\[[^\]]+\]\([^)\s]+\))/g
      let last = 0
      let match
      let index = 0
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) nodes.push(text.slice(last, match.index))
        const token = match[0]
        if (token.startsWith('**')) nodes.push(h('strong', { key: `${keyPrefix}-b${index}` }, token.slice(2, -2)))
        else if (token.startsWith('`')) nodes.push(h('code', { key: `${keyPrefix}-c${index}` }, token.slice(1, -1)))
        else if (token.startsWith('[')) {
          const split = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)
          nodes.push(h('a', {
            key: `${keyPrefix}-l${index}`,
            href: split[2],
            target: '_blank',
            rel: 'noreferrer noopener',
          }, split[1]))
        } else nodes.push(h('em', { key: `${keyPrefix}-i${index}` }, token.slice(1, -1)))
        last = match.index + token.length
        index += 1
      }
      if (last < text.length) nodes.push(text.slice(last))
      return nodes
    }

    function renderMarkdown(text, options) {
      const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
      const blocks = []
      let list = null
      let fence = null

      const flushList = () => {
        if (list === null) return
        blocks.push(h('ul', { key: `ul${blocks.length}`, className: 'dsh-todo__md-list' }, list.items))
        list = null
      }

      for (const raw of lines) {
        const fenceStart = /^```\s*(\S*)\s*$/.exec(raw)
        if (fenceStart !== null) {
          if (fence === null) {
            flushList()
            fence = { language: fenceStart[1], lines: [] }
          } else {
            blocks.push(h('pre', { key: `pre${blocks.length}`, className: 'dsh-todo__md-code' },
              h('code', { 'data-language': fence.language }, fence.lines.join('\n'))))
            fence = null
          }
          continue
        }
        if (fence !== null) {
          fence.lines.push(raw)
          continue
        }

        const task = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(raw)
        if (task !== null) {
          const checked = task[1].toLowerCase() === 'x'
          const title = task[2]
          const meta = /\s+·\s+⏰\s+(.+)$/.exec(title)
          const head = meta === null ? title : title.slice(0, meta.index)
          const row = h('li', { key: `task${blocks.length}-${list === null ? 0 : list.items.length}`, className: 'dsh-todo__md-task' },
            h('button', {
              type: 'button',
              className: `dsh-todo__md-check${checked ? ' is-done' : ''}`,
              role: 'checkbox',
              'aria-checked': checked ? 'true' : 'false',
              disabled: options.readonly,
              onClick: (event) => {
                event.stopPropagation()
                options.onToggleTitle(checked ? 'uncomplete' : 'complete', head.trim())
              },
            }),
            h('span', { className: 'dsh-todo__md-task-text' }, inlineNodes(head, `md${blocks.length}`)),
            meta === null ? null : h('span', { className: 'dsh-todo__md-meta' }, meta[1].trim()))
          if (list === null) list = { items: [] }
          list.items.push(row)
          continue
        }

        const bullet = /^\s*[-*]\s+(.*)$/.exec(raw)
        if (bullet !== null) {
          if (list === null) list = { items: [] }
          list.items.push(h('li', { key: `li${blocks.length}-${list.items.length}`, className: 'dsh-todo__md-item' },
            inlineNodes(bullet[1], `li${blocks.length}`)))
          continue
        }

        flushList()
        if (raw.trim() === '') continue

        const heading = /^(#{1,4})\s+(.*)$/.exec(raw)
        if (heading !== null) {
          const level = heading[1].length
          blocks.push(h(`h${level}`, { key: `h${blocks.length}`, className: 'dsh-todo__md-h' },
            inlineNodes(heading[2], `h${blocks.length}`)))
          continue
        }
        if (/^>\s?/.test(raw)) {
          blocks.push(h('blockquote', { key: `q${blocks.length}`, className: 'dsh-todo__md-quote' },
            inlineNodes(raw.replace(/^>\s?/, ''), `q${blocks.length}`)))
          continue
        }
        if (/^\s{2,}\S/.test(raw) && blocks.length > 0) {
          const previous = blocks[blocks.length - 1]
          if (previous?.props?.className === 'dsh-todo__md-note') {
            blocks[blocks.length - 1] = h('div', { ...previous.props, className: 'dsh-todo__md-note' },
              `${previous.props.children}\n${raw.trim()}`)
          } else {
            blocks.push(h('div', { key: `n${blocks.length}`, className: 'dsh-todo__md-note' }, raw.trim()))
          }
          continue
        }
        if (/^(-{3,}|\*{3,})$/.test(raw.trim())) {
          blocks.push(h('hr', { key: `hr${blocks.length}`, className: 'dsh-todo__md-hr' }))
          continue
        }
        blocks.push(h('p', { key: `p${blocks.length}`, className: 'dsh-todo__md-p' },
          inlineNodes(raw, `p${blocks.length}`)))
      }
      flushList()
      if (fence !== null) {
        blocks.push(h('pre', { key: 'pre-open', className: 'dsh-todo__md-code' }, h('code', {}, fence.lines.join('\n'))))
      }
      return blocks
    }

    // ── 图标 ────────────────────────────────────────────────────────────────
    function TodoIcon({ size = 20, active = false }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': true,
        className: 'dsh-todo__icon',
        style: { color: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)' },
      },
      h('path', {
        d: 'M9 4h8a2 2 0 0 1 2 2v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a2 2 0 0 1 2-2h2Z',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinejoin: 'round',
      }),
      h('path', { d: 'M8.5 9.5l1.6 1.6 3-3', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      h('path', { d: 'M8.5 15.5h4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      h('circle', { cx: 16, cy: 16, r: 3.6, fill: 'var(--dsw-alias-bg-base)', stroke: 'currentColor', strokeWidth: 1.6 }),
      h('path', { d: 'M16 14.4V16l1.1.8', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }))
    }

    // ── 小组件 ──────────────────────────────────────────────────────────────
    function Segmented({ value, options, onChange, ariaLabel }) {
      return h('div', { className: 'dsh-todo__segmented', role: 'tablist', 'aria-label': ariaLabel },
        options.map((option) => h('button', {
          key: option.value,
          type: 'button',
          role: 'tab',
          className: `dsh-todo__segment${value === option.value ? ' is-active' : ''}`,
          'aria-selected': value === option.value ? 'true' : 'false',
          onClick: () => onChange(option.value),
        }, option.label)))
    }

    function Field({ label, children }) {
      return h('label', { className: 'dsh-todo__field' },
        h('span', { className: 'dsh-todo__field-label' }, label),
        children)
    }

    const MODE_LABEL = (t, mode) => ({
      none: t('modeNone'),
      once: t('modeOnce'),
      daily: t('modeDaily'),
      lead: t('modeLead'),
    }[mode] ?? mode)
    const PRIORITY_LABEL = (t, priority) => ({
      low: t('priorityLow'),
      normal: t('priorityNormal'),
      high: t('priorityHigh'),
    }[priority] ?? priority)

    function TaskEditor({ todo, t, busy, onSave, onCancel, onDelete }) {
      const [title, setTitle] = useState(todo.title)
      const [note, setNote] = useState(todo.note ?? '')
      const [mode, setMode] = useState(todo.reminder.mode)
      const [remindAt, setRemindAt] = useState(todo.nextReminderInput ?? '')
      const [remindTime, setRemindTime] = useState(todo.remindTimeInput || '09:00')
      const [leadMinutes, setLeadMinutes] = useState(String(todo.reminder.leadMinutes ?? 10))
      const [due, setDue] = useState(todo.dueInput ?? '')
      const [priority, setPriority] = useState(todo.priority)
      const [tags, setTags] = useState((todo.tags ?? []).join(', '))

      const submit = () => {
        const reminder = { mode }
        if (mode === 'daily') reminder.time = remindTime
        if (mode === 'once') reminder.atLocal = remindAt
        if (mode === 'lead') {
          reminder.atLocal = remindAt
          reminder.leadMinutes = Number(leadMinutes) || 0
        }
        onSave(todo.id, {
          title,
          note,
          dueLocal: due,
          priority,
          tags: tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
          reminder,
        })
      }

      return h('div', { className: 'dsh-todo__editor', onClick: (event) => event.stopPropagation() },
        h(Field, { label: t('title') },
          h('input', {
            className: 'dsh-todo__input',
            value: title,
            onChange: (event) => setTitle(event.target.value),
          })),
        h('div', { className: 'dsh-todo__editor-grid' },
          h(Field, { label: t('mode') },
            h('select', {
              className: 'dsh-todo__select',
              value: mode,
              onChange: (event) => setMode(event.target.value),
            }, REMINDER_MODES.map((value) => h('option', { key: value, value }, MODE_LABEL(t, value))))),
          (mode === 'once' || mode === 'lead')
            ? h(Field, { label: t('remindAt') },
              h('input', {
                type: 'datetime-local',
                className: 'dsh-todo__input',
                value: remindAt,
                onChange: (event) => setRemindAt(event.target.value),
              }))
            : null,
          mode === 'daily'
            ? h(Field, { label: t('remindTime') },
              h('input', {
                type: 'time',
                className: 'dsh-todo__input',
                value: remindTime,
                onChange: (event) => setRemindTime(event.target.value),
              }))
            : null,
          mode === 'lead'
            ? h(Field, { label: t('leadMinutes') },
              h('input', {
                type: 'number',
                min: '0',
                className: 'dsh-todo__input',
                value: leadMinutes,
                onChange: (event) => setLeadMinutes(event.target.value),
              }))
            : null,
          h(Field, { label: t('due') },
            h('input', {
              type: 'datetime-local',
              className: 'dsh-todo__input',
              value: due,
              onChange: (event) => setDue(event.target.value),
            })),
          h(Field, { label: t('priority') },
            h('select', {
              className: 'dsh-todo__select',
              value: priority,
              onChange: (event) => setPriority(event.target.value),
            }, PRIORITIES.map((value) => h('option', { key: value, value }, PRIORITY_LABEL(t, value)))))),
        h(Field, { label: t('note') },
          h('textarea', {
            className: 'dsh-todo__textarea',
            rows: 4,
            value: note,
            placeholder: t('notePlaceholder'),
            onChange: (event) => setNote(event.target.value),
          })),
        h(Field, { label: t('tags') },
          h('input', {
            className: 'dsh-todo__input',
            value: tags,
            placeholder: t('tagsPlaceholder'),
            onChange: (event) => setTags(event.target.value),
          })),
        h('div', { className: 'dsh-todo__editor-actions' },
          h('button', { type: 'button', className: 'dsh-todo__btn is-primary', disabled: busy, onClick: submit }, t('save')),
          h('button', { type: 'button', className: 'dsh-todo__btn', disabled: busy, onClick: onCancel }, t('cancel')),
          h('button', { type: 'button', className: 'dsh-todo__btn is-danger', disabled: busy, onClick: () => onDelete(todo.id) }, t('delete'))))
    }

    function TaskRow({ todo, t, expanded, busy, onToggle, onExpand, onSave, onCancel, onDelete }) {
      return h('div', {
        className: `dsh-todo__row${todo.done ? ' is-done' : ''}${expanded ? ' is-open' : ''}`,
        onClick: () => onExpand(expanded ? null : todo.id),
      },
      h('div', { className: 'dsh-todo__row-main' },
        h('button', {
          type: 'button',
          className: `dsh-todo__check${todo.done ? ' is-done' : ''}`,
          role: 'checkbox',
          'aria-checked': todo.done ? 'true' : 'false',
          'aria-label': todo.title,
          disabled: busy,
          onClick: (event) => {
            event.stopPropagation()
            onToggle(todo.id)
          },
        }),
        h('div', { className: 'dsh-todo__row-body' },
          h('div', { className: 'dsh-todo__row-title' }, todo.title),
          h('div', { className: 'dsh-todo__chips' },
            h('span', { className: 'dsh-todo__chip', title: `${t('created')} ${todo.createdLocal}` },
              `${t('created')} ${todo.createdLocal}`),
            h('span', { className: 'dsh-todo__chip' },
              `${t('remind')} ${MODE_LABEL(t, todo.reminder.mode)}${todo.nextReminderLocal === '' ? '' : ` · ${todo.nextReminderLocal}`}`),
            todo.dueInput === ''
              ? null
              : h('span', {
                className: `dsh-todo__chip${todo.overdue ? ' is-error' : todo.dueToday ? ' is-warn' : ''}`,
              }, `${t('due')} ${todo.dueLocal}`),
            todo.reminderState === 'due'
              ? h('span', { className: 'dsh-todo__chip is-warn' }, t('remindDueBadge'))
              : null,
            todo.reminderState === 'fired'
              ? h('span', { className: 'dsh-todo__chip is-idle' }, t('remindedBadge'))
              : null,
            todo.priority === 'normal' ? null : h('span', { className: 'dsh-todo__chip' }, PRIORITY_LABEL(t, todo.priority)),
            (todo.tags ?? []).map((tag) => h('span', { key: tag, className: 'dsh-todo__chip' }, `#${tag}`)))),
        h('span', { className: 'dsh-todo__row-edit' }, expanded ? t('cancel') : t('edit'))),
      expanded
        ? h(TaskEditor, {
          todo,
          t,
          busy,
          onSave,
          onCancel: () => onExpand(null),
          onDelete,
        })
        : null)
    }

    function ListView({ data, t, api, busy, run }) {
      const [draft, setDraft] = useState('')
      const [filter, setFilter] = useState(data.prefs.filter)
      const [expanded, setExpanded] = useState(null)

      const todos = useMemo(() => {
        const all = data.todos
        if (filter === 'open') return all.filter((todo) => !todo.done)
        if (filter === 'done') return all.filter((todo) => todo.done)
        if (filter === 'today') return all.filter((todo) => todo.dueToday)
        return all
      }, [data.todos, filter])

      const submit = () => {
        const title = draft.trim()
        if (title === '') return
        setDraft('')
        void run(() => api.create({ title }))
      }

      const changeFilter = (value) => {
        setFilter(value)
        void run(() => api.setPrefs({ filter: value }))
      }

      return h('div', { className: 'dsh-todo__list' },
        h('div', { className: 'dsh-todo__composer' },
          h('input', {
            className: 'dsh-todo__input is-primary',
            value: draft,
            placeholder: t('placeholder'),
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') submit()
            },
          }),
          h('button', { type: 'button', className: 'dsh-todo__btn is-primary', disabled: busy, onClick: submit }, t('add'))),
        h('div', { className: 'dsh-todo__toolbar' },
          h(Segmented, {
            value: filter,
            ariaLabel: t('panel'),
            onChange: changeFilter,
            options: FILTERS.map((value) => ({ value, label: t(`filter${value[0].toUpperCase()}${value.slice(1)}`) })),
          }),
          h('span', { className: 'dsh-todo__spacer' }),
          h('button', {
            type: 'button',
            className: 'dsh-todo__btn is-quiet',
            disabled: busy || data.counts.done === 0,
            onClick: () => void run(() => api.clearCompleted()),
          }, t('clearDone'))),
        h('div', { className: 'dsh-todo__rows' },
          todos.length === 0
            ? h('div', { className: 'dsh-todo__empty' }, data.todos.length === 0 ? t('empty') : t('emptyFilter'))
            : todos.map((todo) => h(TaskRow, {
              key: todo.id,
              todo,
              t,
              busy,
              expanded: expanded === todo.id,
              onExpand: setExpanded,
              onToggle: (id) => void run(() => api.toggle(id)),
              onSave: (id, patch) => {
                setExpanded(null)
                void run(() => api.update(id, patch))
              },
              onCancel: () => setExpanded(null),
              onDelete: (id) => {
                setExpanded(null)
                void run(() => api.remove(id))
              },
            }))))
    }

    function MarkdownView({ data, t, api, busy, run, markdown }) {
      const [source, setSource] = useState(markdown)
      const [mode, setMode] = useState('preview')
      const dirty = useRef(false)

      useEffect(() => {
        if (!dirty.current) setSource(markdown)
      }, [markdown])

      const toggleByTitle = useCallback((intent, title) => {
        const target = data.todos.find((todo) => todo.title === title)
        if (target === undefined) return
        void run(() => api.update(target.id, { done: intent === 'complete' }))
      }, [api, data.todos, run])

      return h('div', { className: 'dsh-todo__md' },
        h('div', { className: 'dsh-todo__toolbar' },
          h(Segmented, {
            value: mode,
            ariaLabel: t('viewMarkdown'),
            onChange: setMode,
            options: [
              { value: 'preview', label: t('preview') },
              { value: 'source', label: t('source') },
            ],
          }),
          h('span', { className: 'dsh-todo__spacer' }),
          h('button', {
            type: 'button',
            className: 'dsh-todo__btn is-quiet',
            onClick: () => {
              void navigator.clipboard?.writeText(markdown)
            },
          }, t('copy')),
          h('button', {
            type: 'button',
            className: 'dsh-todo__btn is-primary',
            disabled: busy,
            onClick: () => void run(async () => {
              const result = await api.saveMarkdown(source)
              dirty.current = false
              if (result?.markdown !== undefined) setSource(result.markdown)
            }),
          }, t('applied'))),
        mode === 'preview'
          ? h('div', { className: 'dsh-todo__md-body' }, renderMarkdown(markdown, {
            readonly: busy,
            onToggleTitle: toggleByTitle,
          }))
          : h('textarea', {
            className: 'dsh-todo__textarea is-source',
            spellCheck: false,
            value: source,
            onChange: (event) => {
              dirty.current = true
              setSource(event.target.value)
            },
          }))
    }

    /**
     * 对话输入框下方的待办条：在 start 页面与任何会话里都能看到。
     * 只显示计数与最近两项，点一下打开完整面板。
     */
    function TodoStrip({ api, t, layout }) {
      const [counts, setCounts] = useState(null)
      const [top, setTop] = useState([])

      useEffect(() => {
        let stopped = false
        const load = () => {
          api.snapshot()
            .then((next) => {
              if (stopped) return
              setCounts(next.counts)
              setTop(next.todos.filter((todo) => !todo.done).slice(0, 2))
            })
            .catch(() => undefined)
        }
        load()
        const timer = setInterval(load, 60_000)
        return () => {
          stopped = true
          clearInterval(timer)
        }
      }, [api])

      if (counts === null || counts.total === 0) return null

      const open = () => {
        if (typeof layout?.selectPanel === 'function') layout.selectPanel('todo')
      }
      return h('div', { className: 'dsh-todo-strip' },
        h(CoreStyles),
        h('button', { type: 'button', className: 'dsh-todo-strip__count', onClick: open },
          h(TodoIcon, { size: 14 }),
          h('span', {}, t('stripOpen', { open: counts.open })),
          counts.today > 0 ? h('span', { className: 'dsh-todo-strip__sep' }, '·') : null,
          counts.today > 0 ? h('span', { className: 'dsh-todo-strip__today' }, t('stripToday', { today: counts.today })) : null),
        top.map((todo) => h('button', {
          key: todo.id,
          type: 'button',
          className: 'dsh-todo-strip__item',
          title: todo.title,
          onClick: open,
        }, todo.title)))
    }

    /**
     * New Session 行里的紧凑选项：和 Workspace files / New terminal / Browser 同一块区域。
     * 宿主自带的三个快捷操作是内置的，不走槽位；这里是官方留给插件的位置。
     */
    function TodoHeroOption({ api, t, layout }) {
      const [counts, setCounts] = useState(null)

      useEffect(() => {
        let stopped = false
        const load = () => {
          api.snapshot()
            .then((next) => { if (!stopped) setCounts(next.counts) })
            .catch(() => undefined)
        }
        load()
        const timer = setInterval(load, 60_000)
        return () => {
          stopped = true
          clearInterval(timer)
        }
      }, [api])

      if (counts === null || counts.total === 0) return null
      const open = () => {
        if (typeof layout?.selectPanel === 'function') layout.selectPanel('todo')
      }
      return h(React.Fragment, null,
        h(CoreStyles),
        h('button', {
          type: 'button',
          className: 'dsh-todo-strip__count',
          title: t('panel'),
          onClick: open,
        },
        h(TodoIcon, { size: 14 }),
        h('span', {}, t('stripOpen', { open: counts.open })),
        counts.today > 0 ? h('span', { className: 'dsh-todo-strip__sep' }, '·') : null,
        counts.today > 0 ? h('span', { className: 'dsh-todo-strip__today' }, t('stripToday', { today: counts.today })) : null))
    }

    // ── 面板 ────────────────────────────────────────────────────────────────
    function TodoPanel({ api, t, layout }) {
      const [data, setData] = useState(null)
      const [markdown, setMarkdown] = useState('')
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState(false)
      const noticeTimer = useRef(null)

      const applySnapshot = useCallback((next) => {
        setData(next)
        setMarkdown(next.markdown ?? '')
      }, [])

      const refresh = useCallback(async () => {
        const next = await api.snapshot()
        applySnapshot(next)
        setError(null)
        return next
      }, [api, applySnapshot])

      // 所有面板动作都经过这里：置忙 → 执行 → 重新取快照 → 失败上屏。
      const run = useCallback(async (action) => {
        setBusy(true)
        try {
          await action()
          applySnapshot(await api.snapshot())
          setError(null)
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }, [api, applySnapshot])

      useEffect(() => {
        let cancelled = false
        setBusy(true)
        api.snapshot()
          .then((next) => {
            if (!cancelled) applySnapshot(next)
          })
          .catch((cause) => {
            if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
          })
          .finally(() => {
            if (!cancelled) setBusy(false)
          })
        return () => {
          cancelled = true
        }
      }, [api, applySnapshot])

      // 提醒扫描：到期后在面板上给出提示，不代替用户做任何操作。
      useEffect(() => {
        let stopped = false
        const tick = () => {
          api.sweep()
            .then((result) => {
              if (stopped || (result?.due?.length ?? 0) === 0) return
              setNotice(result.due.length)
              if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
              noticeTimer.current = setTimeout(() => {
                noticeTimer.current = null
                api.snapshot()
                  .then((next) => {
                    if (!stopped) applySnapshot(next)
                  })
                  .catch(() => undefined)
              }, 4000)
            })
            .catch(() => undefined)
        }
        const timer = setInterval(tick, 30_000)
        return () => {
          stopped = true
          clearInterval(timer)
          if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
        }
      }, [api, applySnapshot])

      const view = data?.prefs?.view ?? 'list'
      const switchView = (next) => void run(() => api.setPrefs({ view: next }))

      if (data === null) {
        return h('div', { className: 'dsh-todo' },
          h(Stylesheet),
          h('div', { className: 'dsh-todo__banner is-error' }, error ?? t('loading')))
      }

      // selectPanel(null) 是宿主提供的「回到对话」语义，不需要猜上一个面板 id。
      const canReturn = typeof layout?.selectPanel === 'function'
      return h('div', { className: 'dsh-todo' },
        h(Stylesheet),
        h('header', { className: 'dsh-todo__bar' },
          h('div', { className: 'dsh-todo__heading' },
            canReturn
              ? h('button', {
                type: 'button',
                className: 'dsh-todo__back',
                title: t('backToChat'),
                onClick: () => layout.selectPanel(null),
              }, '←', h('span', { className: 'dsh-todo__back-label' }, t('backToChat')))
              : null,
            h(TodoIcon, { size: 18 }),
            h('span', { className: 'dsh-todo__title' }, t('panel')),
            h('span', { className: 'dsh-todo__summary' }, t('createdSummary', {
              total: data.counts.total,
              open: data.counts.open,
              today: data.counts.today,
            }))),
          h(Segmented, {
            value: view,
            ariaLabel: t('panel'),
            onChange: switchView,
            options: [
              { value: 'list', label: t('viewList') },
              { value: 'markdown', label: t('viewMarkdown') },
            ],
          })),
        error === null ? null : h('div', { className: 'dsh-todo__banner is-error' }, error),
        notice === null
          ? null
          : h('div', { className: 'dsh-todo__banner is-warn' }, t('dueNotice', { count: notice })),
        view === 'markdown'
          ? h(MarkdownView, { data, t, api, busy, run, markdown })
          : h(ListView, { data, t, api, busy, run }))
    }

    // ── 样式 ────────────────────────────────────────────────────────────────
    const CSS = `
.dsh-todo{--dsh-todo-gap:12px;display:flex;flex-direction:column;height:100%;min-height:0;gap:var(--dsh-todo-gap);padding:20px 24px;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55;}
.dsh-todo__bar{display:flex;align-items:center;justify-content:space-between;gap:var(--dsh-todo-gap);flex-wrap:wrap;}
.dsh-todo__heading{display:flex;align-items:center;gap:8px;min-width:0;}
.dsh-todo__title{font-size:15px;font-weight:600;}
.dsh-todo__summary{color:var(--dsw-alias-label-secondary);font-size:12px;}
.dsh-todo__segmented{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);}
.dsh-todo__segment{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;padding:4px 12px;border-radius:6px;cursor:pointer;}
.dsh-todo__segment:hover{color:var(--dsw-alias-label-primary);}
.dsh-todo__segment.is-active{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);}
.dsh-todo__list,.dsh-todo__md{display:flex;flex-direction:column;gap:var(--dsh-todo-gap);min-height:0;flex:1;}
.dsh-todo__composer{display:flex;gap:8px;}
.dsh-todo__toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.dsh-todo__spacer{flex:1;}
.dsh-todo__rows{display:flex;flex-direction:column;gap:6px;overflow:auto;min-height:0;flex:1;padding-right:4px;}
.dsh-todo__row{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);cursor:pointer;}
.dsh-todo__row:hover{border-color:var(--dsw-alias-border-l2);}
.dsh-todo__row.is-open{border-color:var(--dsw-alias-brand-primary);}
.dsh-todo__row-main{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;}
.dsh-todo__row-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;}
.dsh-todo__row-title{font-weight:500;overflow-wrap:anywhere;}
.dsh-todo__row.is-done .dsh-todo__row-title{color:var(--dsw-alias-label-secondary);text-decoration:line-through;}
.dsh-todo__row-edit{color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap;align-self:center;}
.dsh-todo__check{flex:none;width:16px;height:16px;margin-top:2px;border-radius:4px;border:1.5px solid var(--dsw-alias-border-l2);background:transparent;cursor:pointer;padding:0;}
.dsh-todo__check.is-done{background:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);}
.dsh-todo__chips{display:flex;flex-wrap:wrap;gap:6px;}
.dsh-todo__chip{font-size:11px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 8px;white-space:nowrap;}
.dsh-todo__chip.is-error{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);}
.dsh-todo__chip.is-warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary);}
.dsh-todo__chip.is-idle{color:var(--dsw-alias-state-idle-primary);border-color:var(--dsw-alias-state-idle-primary);}
.dsh-todo__editor{display:flex;flex-direction:column;gap:8px;padding:12px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);border-radius:0 0 10px 10px;}
.dsh-todo__editor-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;}
.dsh-todo__editor-actions{display:flex;gap:8px;}
.dsh-todo__field{display:flex;flex-direction:column;gap:4px;min-width:0;}
.dsh-todo__field-label{font-size:11px;color:var(--dsw-alias-label-secondary);}
.dsh-todo__input,.dsh-todo__select,.dsh-todo__textarea{font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 8px;width:100%;box-sizing:border-box;}
.dsh-todo__input:focus,.dsh-todo__select:focus,.dsh-todo__textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary);}
.dsh-todo__textarea{resize:vertical;min-height:72px;}
.dsh-todo__textarea.is-source{flex:1;min-height:240px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;}
.dsh-todo__btn{font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 12px;cursor:pointer;}
.dsh-todo__btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);}
.dsh-todo__btn:disabled{opacity:.5;cursor:not-allowed;}
.dsh-todo__btn.is-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);}
.dsh-todo__btn.is-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);}
.dsh-todo__btn.is-quiet{background:transparent;}
.dsh-todo__banner{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 12px;font-size:12px;}
.dsh-todo__banner.is-error{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);}
.dsh-todo__banner.is-warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary);}
.dsh-todo__empty{padding:32px 12px;text-align:center;color:var(--dsw-alias-label-secondary);}
.dsh-todo__md-body{flex:1;min-height:0;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:16px 20px;background:var(--dsw-alias-bg-layer-1);}
.dsh-todo__md-h{margin:12px 0 6px;line-height:1.3;}
.dsh-todo__md-h:first-child{margin-top:0;}
.dsh-todo__md-p{margin:4px 0;}
.dsh-todo__md-quote{margin:6px 0;padding-left:10px;border-left:2px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);}
.dsh-todo__md-list{list-style:none;margin:6px 0;padding:0;display:flex;flex-direction:column;gap:4px;}
.dsh-todo__md-task,.dsh-todo__md-item{display:flex;align-items:flex-start;gap:8px;}
.dsh-todo__md-item{padding-left:2px;}
.dsh-todo__md-task-text{flex:1;min-width:0;overflow-wrap:anywhere;}
.dsh-todo__md-meta{color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap;}
.dsh-todo__md-note{color:var(--dsw-alias-label-secondary);font-size:12px;padding-left:26px;white-space:pre-wrap;overflow-wrap:anywhere;}
.dsh-todo__md-check{flex:none;width:14px;height:14px;margin-top:3px;border-radius:4px;border:1.5px solid var(--dsw-alias-border-l2);background:transparent;cursor:pointer;padding:0;}
.dsh-todo__md-check.is-done{background:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);}
.dsh-todo__md-code{background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:10px 12px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;}
.dsh-todo__md-hr{border:0;border-top:1px solid var(--dsw-alias-border-l1);margin:12px 0;}
.dsh-todo__back{display:inline-flex;align-items:center;gap:4px;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:3px 8px;cursor:pointer;}
.dsh-todo__back:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);}
`

    /** 待办条与 hero 按钮的样式：它们可能不伴随面板出现，需要自带。 */
    const CORE_CSS = `
.dsh-todo-strip{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:2px 4px;font-size:12px;color:var(--dsw-alias-label-secondary);}
.dsh-todo-strip__count{display:inline-flex;align-items:center;gap:4px;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);background:transparent;border:0;padding:0;cursor:pointer;}
.dsh-todo-strip__count:hover{color:var(--dsw-alias-label-primary);}
.dsh-todo-strip__today{color:var(--dsw-alias-state-warn-primary);}
.dsh-todo-strip__sep{opacity:.6;}
.dsh-todo-strip__item{font:inherit;font-size:12px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 8px;cursor:pointer;}
.dsh-todo-strip__item:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);}
`

    /** 随面板挂载的样式表；面板卸载时由 React 一并移除。 */
    function Stylesheet() {
      return h('style', { 'data-dsh-todo': '' }, CSS)
    }

    /** 轻量入口用的样式表（待办条 / hero 按钮）。 */
    function CoreStyles() {
      return h('style', { 'data-dsh-todo-core': '' }, CORE_CSS)
    }

    return {
      inject: ['slots', 'locale', 'connection'],
      apply(ctx) {
        ctx.effect(() => {
          const stopLocale = ctx.locale.register(NS, { zh: ZH, en: EN })
          const t = ctx.locale.bind(NS)
          const getLocale = () => {
            const snapshot = ctx.locale.getLocale?.() ?? ctx.locale.getSnapshot?.()
            return snapshot?.id ?? snapshot?.locale ?? ''
          }
          const api = createApi(ctx.connection.rpc, getLocale)
          // layout 是可选依赖：拿不到时按钮与跳转自动隐藏，插件其余部分照常工作。
          const layout = ctx.get?.('layout')

          // 样式表不通过任何 builtin 注入：插件 bundle 的 factory 只拿到 require，
          // `styles` 是动态 Client runner 的 builtin，在这里并不存在。
          // 改成随面板一起挂载的 <style> 元素，卸载时 React 自己移除。

          // 侧栏面板图标：id 同时是 main 槽位的 key，点击即切换主区域面板。
          const stopIcon = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: 'todo',
            order: 20,
            label: () => t('panel'),
          }, function TodoPanelIcon(props) {
            return h(TodoIcon, { size: props?.size ?? 20, active: props?.active === true })
          }))

          const stopPanel = ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: 'todo',
          }, function TodoMainPanel() {
            return h(TodoPanel, { api, t, layout })
          }))

          // New Session 行里的紧凑选项，和 workspace / preset 控件同一排。
          const stopHero = ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
            name: 'conversation.hero.options',
            id: 'todo',
            order: 0,
          }, function TodoHeroOptionSlot() {
            return h(TodoHeroOption, { api, t, layout })
          }))

          // 输入框下方的待办条：start 页面与进行中的会话都能看到。
          const stopStrip = ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
            name: 'conversation.composer.dock',
            id: 'todo-strip',
            order: 2,
          }, function TodoStripSlot() {
            return h(TodoStrip, { api, t, layout })
          }))

          return () => {
            stopHero()
            stopStrip()
            stopPanel()
            stopIcon()
            stopLocale()
          }
        }, 'dsh-todo: panel')
      },
    }
  },
})