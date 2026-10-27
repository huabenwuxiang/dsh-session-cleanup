/**
 * 自测：不启动 DSH，只验证 client 半侧的装配形状。
 * - 模块加载器工厂能被调用
 * - apply 往两个 slot 各注册一个条目
 * - 菜单项能渲染出「删除对话…」
 * - 弹窗关闭时渲染 null
 * 运行：node scripts/test-client.mjs
 */
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const dshHome = (process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
const profileRequire = createRequire(join(dshHome, 'profiles', 'package.json'))
const React = profileRequire('react')
const { renderToStaticMarkup } = profileRequire('react-dom/server')

let primitives = null
try {
  primitives = profileRequire('@deepseek-ai/dsh-client-ui-primitives')
} catch {
  primitives = null
}
if (primitives) {
  console.log('primitives:', {
    MenuItemButton: typeof primitives.MenuItemButton,
    RiskConfirmation: typeof primitives.RiskConfirmation,
  })
}

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
}

await import('../lib/client.js')
assert.ok(captured, '应通过 __ModuleLoader__.load 注册')
assert.equal(captured.id, 'dsh-session-cleanup')

const plugin = captured.factory((specifier) => {
  if (specifier === 'react') return React
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
    if (!primitives) throw new Error('no primitives')
    return primitives
  }
  if (specifier === 'react/jsx-runtime') return { jsx: React.createElement }
  throw new Error(`unexpected require: ${specifier}`)
})

assert.equal(plugin.name, 'session-cleanup')
assert.deepEqual(plugin.inject, ['slots'])

const registrations = []
const ctx = {
  slots: {
    inject(_slotName, factory) {
      const result = factory()
      if (result && typeof result.next === 'function') {
        let step = result.next()
        while (!step.done) step = result.next()
      }
    },
    register(definition, Component) {
      registrations.push({ definition, Component })
      return () => {}
    },
  },
}

plugin.apply(ctx)
assert.equal(registrations.length, 2, '应注册菜单项与弹窗两个条目')
const menuEntry = registrations.find((entry) => entry.definition.name === 'sidebar.workspaces.session.menu.item')
const overlayEntry = registrations.find((entry) => entry.definition.name === 'shell.overlay')
assert.ok(menuEntry, '菜单项应注册到 sidebar.workspaces.session.menu.item')
assert.ok(overlayEntry, '弹窗应注册到 shell.overlay')
assert.equal(menuEntry.definition.order, 470)

const props = {
  sessionId: 'session-01942024-7499-451c-a55c-cded11c07d3f',
  displayTitle: '测试对话',
  useMenuOpenState: () => [false, () => {}],
}

let menuHtml = ''
try {
  menuHtml = renderToStaticMarkup(React.createElement(menuEntry.Component, props))
} catch (error) {
  console.warn('真实 primitives 渲染失败，退化为内置按钮再试：', error.message)
  primitives = null
  const fallbackPlugin = captured.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error('no primitives')
  })
  const fallbackRegs = []
  fallbackPlugin.apply({
    slots: {
      inject(_name, factory) {
        const result = factory()
        if (result && typeof result.next === 'function') {
          let step = result.next()
          while (!step.done) step = result.next()
        }
      },
      register(definition, Component) {
        fallbackRegs.push({ definition, Component })
        return () => {}
      },
    },
  })
  const fallbackMenu = fallbackRegs.find((entry) => entry.definition.name === 'sidebar.workspaces.session.menu.item')
  menuHtml = renderToStaticMarkup(React.createElement(fallbackMenu.Component, props))
}

assert.ok(menuHtml.includes('删除对话'), `菜单项文案不对：${menuHtml}`)
console.log('ok 菜单项渲染:', menuHtml)

const overlayHtml = renderToStaticMarkup(React.createElement(overlayEntry.Component))
assert.equal(overlayHtml, '')
console.log('ok 弹窗未打开时渲染为空')

console.log('\n全部通过')
