/**
 * dsh-session-cleanup — client 半侧（Module Loader 工厂，无构建步骤）。
 *
 * 1) 往会话行的「⋯」菜单里加一条「删除对话…」；
 * 2) 用应用自带的 RiskConfirmation 弹确认框（必须勾选“不可恢复”才能删）；
 * 3) 调 host 路由真正删盘，然后刷新页面让侧栏丢掉这一行。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-cleanup',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch (error) {
      console.warn('[session-cleanup] ui-primitives 不可用，使用降级样式：' + (error?.message ?? error))
    }

    const ROUTE = '/dsh-session-cleanup'
    const zh = typeof navigator !== 'undefined' && /^zh/i.test(navigator.language ?? '')
    const copy = zh
      ? {
          menu: '删除对话…',
          title: (title) => `删除「${title}」？`,
          loading: '正在读取占用空间…',
          body: (size) =>
            `将从磁盘永久删除这条对话的日志与索引（${size}），不会进入回收站，也无法恢复。附件与其它对话共用的文件不会被删除。`,
          ack: '我已知晓，删除后无法恢复',
          cancel: '取消',
          confirm: '永久删除',
          busy: '正在删除…',
          running: '这条对话还在生成回复。等这一轮结束（或先点停止），再回来删除。',
          error: (message) => ` 删除失败：${message}`,
          done: '已删除，正在刷新…',
        }
      : {
          menu: 'Delete conversation…',
          title: (title) => `Delete “${title}”?`,
          loading: 'Measuring disk usage…',
          body: (size) =>
            `This permanently removes the conversation log and index from disk (${size}). It will not go to the trash and cannot be undone. Attachments shared with other conversations are kept.`,
          ack: 'I understand this cannot be undone',
          cancel: 'Cancel',
          confirm: 'Delete permanently',
          busy: 'Deleting…',
          running: 'This conversation is still generating a reply. Wait for the turn to finish (or stop it), then delete.',
          error: (message) => ` Delete failed: ${message}`,
          done: 'Deleted. Reloading…',
        }

    // ---- 极简 store：菜单项只负责“发起”，弹窗是全局唯一的 ----
    const listeners = new Set()
    let state = {
      open: false,
      sessionId: null,
      title: '',
      bytes: null,
      loading: false,
      busy: false,
      acknowledged: false,
      error: null,
      done: false,
    }

    function publish(patch) {
      state = { ...state, ...patch }
      for (const listener of listeners) {
        try {
          listener()
        } catch {
          // 忽略单个订阅者的异常
        }
      }
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '未知大小'
      if (bytes < 1024) return `${bytes} B`
      const units = ['KB', 'MB', 'GB']
      let value = bytes / 1024
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
      }
      return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
    }

    async function readJson(response) {
      try {
        return await response.json()
      } catch {
        return null
      }
    }

    async function openDialog(sessionId, title) {
      publish({
        open: true,
        sessionId,
        title: title || sessionId,
        bytes: null,
        loading: true,
        busy: false,
        acknowledged: false,
        error: null,
        done: false,
      })
      try {
        const response = await fetch(`${ROUTE}/stat?id=${encodeURIComponent(sessionId)}`)
        const payload = await readJson(response)
        if (state.sessionId !== sessionId) return
        if (!response.ok || !payload?.ok) {
          publish({ loading: false, error: payload?.error?.message ?? `HTTP ${response.status}` })
          return
        }
        publish({ loading: false, bytes: payload.bytes })
        if (payload.running) publish({ error: copy.running })
      } catch (error) {
        if (state.sessionId !== sessionId) return
        publish({ loading: false, error: error?.message ?? String(error) })
      }
    }

    function closeDialog() {
      if (state.busy) return
      publish({ open: false, sessionId: null })
    }

    async function confirmDelete() {
      if (!state.sessionId || state.busy) return
      publish({ busy: true, error: null })
      try {
        const response = await fetch(`${ROUTE}/delete`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: state.sessionId }),
        })
        const payload = await readJson(response)
        if (!response.ok || !payload?.ok) {
          publish({ busy: false, error: payload?.error?.message ?? `HTTP ${response.status}` })
          return
        }
        publish({ busy: false, done: true })
        // 侧栏的列表来自 Host 投影，删完刷新一次最省事也最不会残留。
        window.setTimeout(() => {
          try {
            window.location.reload()
          } catch {
            // 忽略
          }
        }, 450)
      } catch (error) {
        publish({ busy: false, error: error?.message ?? String(error) })
      }
    }

    // ---- 菜单项 ----
    function DeleteMenuItem(props) {
      const sessionId = props?.sessionId
      const displayTitle = props?.displayTitle ?? ''
      const useMenuOpenState = props?.useMenuOpenState
      // 该 hook 由 slot 提供；取不到时退化成“手动关不掉菜单”，不影响删除本身。
      const menuOpen = typeof useMenuOpenState === 'function' ? useMenuOpenState() : null
      const setMenuOpen = menuOpen && typeof menuOpen[1] === 'function' ? menuOpen[1] : () => {}

      const onSelect = () => {
        setMenuOpen(false)
        void openDialog(sessionId, displayTitle)
      }

      if (primitives?.MenuItemButton) {
        return h(
          primitives.MenuItemButton,
          { separatorBefore: true, onSelect },
          copy.menu,
        )
      }
      return h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          onClick: onSelect,
          style: {
            display: 'block',
            width: '100%',
            textAlign: 'left',
            padding: '6px 10px',
            border: 0,
            borderRadius: 6,
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
            font: 'inherit',
          },
        },
        copy.menu,
      )
    }

    // ---- 全局确认弹窗 ----
    function CleanupOverlay() {
      const [, forceRender] = React.useReducer((value) => value + 1, 0)
      React.useEffect(() => subscribe(forceRender), [])

      if (!state.open) return null

      const description = state.done
        ? copy.done
        : state.loading
          ? copy.loading
          : `${copy.body(formatBytes(state.bytes))}${state.error ? copy.error(state.error) : ''}`

      const risk = primitives?.RiskConfirmation
      if (risk) {
        return h(risk, {
          open: true,
          title: copy.title(state.title),
          description,
          acknowledgeLabel: copy.ack,
          cancelLabel: copy.cancel,
          confirmLabel: state.busy ? copy.busy : copy.confirm,
          acknowledged: state.acknowledged,
          disabled: state.busy || state.loading || state.done || Boolean(state.error),
          onAcknowledgedChange: (next) => publish({ acknowledged: Boolean(next) }),
          onCancel: closeDialog,
          onConfirm: () => void confirmDelete(),
        })
      }

      const card = h(
        'div',
        {
          style: {
            width: 440,
            maxWidth: '92vw',
            padding: 20,
            borderRadius: 12,
            background: '#fff',
            color: '#111',
            boxShadow: '0 20px 60px rgba(0,0,0,.35)',
            font: '14px/1.6 system-ui, sans-serif',
          },
        },
        h('div', { style: { fontWeight: 600, marginBottom: 8 } }, copy.title(state.title)),
        h('div', { style: { marginBottom: 12, whiteSpace: 'pre-wrap' } }, description),
        h(
          'label',
          { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 } },
          h('input', {
            type: 'checkbox',
            checked: state.acknowledged,
            disabled: state.busy || state.done,
            onChange: (event) => publish({ acknowledged: Boolean(event.target.checked) }),
          }),
          copy.ack,
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
          h('button', { type: 'button', onClick: closeDialog, disabled: state.busy }, copy.cancel),
          h(
            'button',
            {
              type: 'button',
              onClick: () => void confirmDelete(),
              disabled: state.busy || state.done || !state.acknowledged,
            },
            copy.confirm,
          ),
        ),
      )

      return h(
        'div',
        {
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 2147483000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,.38)',
          },
        },
        h('div', { style: { width: 480, maxWidth: '94vw' } }, card),
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
        ctx.slots.register(
          {
            name: 'sidebar.workspaces.session.menu.item',
            id: 'session-cleanup.delete',
            // 内置「复制 Session ID」是 450；删除排在它后面，并用分隔线单独成组。
            order: 470,
          },
          DeleteMenuItem,
        ),
      )

      ctx.slots.inject('shell.overlay', function* () {
        yield ctx.slots.register(
          { name: 'shell.overlay', id: 'session-cleanup.dialog', order: 1500 },
          CleanupOverlay,
        )
      })

      console.info('[session-cleanup] 菜单项与确认弹窗已注册')
    }

    return { name: 'session-cleanup', inject, apply }
  },
})
