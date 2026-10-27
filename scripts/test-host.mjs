/**
 * 自测：用假的 DSH_HOME 验证删除逻辑 + HTTP 路由，不碰真实数据。
 * 运行：node scripts/test-host.mjs
 */
import { mkdtemp, mkdir, writeFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'

const home = await mkdtemp(join(tmpdir(), 'dsh-cleanup-'))
process.env.DSH_HOME = home

const { removeSession, inspectSession, apply } = await import('../lib/index.js')

const id = 'session-01942024-7499-451c-a55c-cded11c07d3f'
const slug = '--C-Users-test-Desktop-demo--'
const sessionDir = join(home, 'sessions', slug, id)
const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
const cacheFile = join(cacheDir, `${id}.json`)

async function seed(sessionId) {
  const dir = join(home, 'sessions', slug, sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(2048, 7))
  await mkdir(join(dir, 'subagents', 'child'), { recursive: true })
  await writeFile(join(dir, 'subagents', 'child', 'log.zst'), Buffer.alloc(1024, 1))
  await mkdir(cacheDir, { recursive: true })
  await writeFile(join(cacheDir, `${sessionId}.json`), '{}')
}

await seed(id)

const detached = []
function makeCtx({ agentStatus = null } = {}) {
  return {
    agents: { get: () => (agentStatus ? { id, status: agentStatus } : undefined) },
    workspaceRegistry: {
      list: () => [
        {
          id: 'w1',
          title: 'demo',
          sessionIds: [id],
          detachSession: async (sessionId) => {
            detached.push(sessionId)
          },
        },
      ],
    },
  }
}

// 1) 预检
const info = await inspectSession(makeCtx(), id)
assert.equal(info.exists, true)
assert.equal(info.bytes, 3072)
assert.equal(info.files, 2)
assert.equal(info.running, false)
assert.deepEqual(info.workspaces, [{ id: 'w1', title: 'demo' }])
console.log('ok 1 预检:', info)

// 2) 还在生成回复的不让删
await assert.rejects(() => removeSession(makeCtx({ agentStatus: 'running' }), id), (error) => {
  assert.equal(error.code, 'SESSION_RUNNING')
  return true
})
assert.ok((await stat(sessionDir)).isDirectory(), '正在生成的会话不能被删')
console.log('ok 2 生成中拒绝删除')

// 2b) 已停下（idle）的会话，哪怕还开着也允许删
const idleId = 'session-22222222-3333-4444-5555-666666666666'
await seed(idleId)
const idleResult = await removeSession(makeCtx({ agentStatus: 'idle' }), idleId)
assert.equal(idleResult.removedDirs, 1)
await assert.rejects(() => stat(join(home, 'sessions', slug, idleId)))
console.log('ok 2b 空闲会话可删')

// 3) 非法 id
for (const bad of ['', 'abc', 'session-../../etc', 'session-01942024-7499-451c-a55c-cded11c07d3f/../x']) {
  await assert.rejects(() => removeSession(makeCtx(), bad), (error) => {
    assert.equal(error.code, 'INVALID_SESSION_ID')
    return true
  })
}
console.log('ok 3 非法 id 被拒')

// 4) 正常删除
const result = await removeSession(makeCtx(), id)
assert.equal(result.removedBytes, 3072)
assert.equal(result.removedDirs, 1)
assert.equal(result.detached, 1)
assert.deepEqual(detached, [id])
await assert.rejects(() => stat(sessionDir))
await assert.rejects(() => stat(cacheFile))
console.log('ok 4 删除完成:', result)

// 5) 再删一次 -> 404
await assert.rejects(() => removeSession(makeCtx(), id), (error) => {
  assert.equal(error.code, 'NOT_FOUND')
  return true
})
console.log('ok 5 重复删除返回 NOT_FOUND')

// 6) HTTP 路由
const id2 = 'session-11111111-2222-3333-4444-555555555555'
await seed(id2)
const detached2 = []
let handler = null
apply({
  effect: (factory) => {
    factory()
  },
  webServer: {
    register: (route) => {
      handler = route.handler
      return () => {}
    },
  },
  agents: { get: () => undefined },
  workspaceRegistry: {
    list: () => [
      {
        id: 'w1',
        title: 'demo',
        sessionIds: [id2],
        detachSession: async (sessionId) => {
          detached2.push(sessionId)
        },
      },
    ],
  },
})
assert.ok(handler, 'apply 应注册路由')

const server = http.createServer((req, res) => handler(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const health = await (await fetch(`${base}/dsh-session-cleanup/health`)).json()
assert.equal(health.ok, true)
assert.equal(health.home, home)

const statPayload = await (await fetch(`${base}/dsh-session-cleanup/stat?id=${id2}`)).json()
assert.equal(statPayload.ok, true)
assert.equal(statPayload.bytes, 3072)
assert.equal(statPayload.running, false)

const forbidden = await fetch(`${base}/dsh-session-cleanup/stat?id=${id2}`, {
  headers: { origin: 'http://evil.example.com' },
})
assert.equal(forbidden.status, 403)

const deleted = await (
  await fetch(`${base}/dsh-session-cleanup/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: id2 }),
  })
).json()
assert.equal(deleted.ok, true)
assert.equal(deleted.detached, 1)
assert.deepEqual(detached2, [id2])
await assert.rejects(() => stat(join(home, 'sessions', slug, id2)))
console.log('ok 6 HTTP 路由:', deleted)

const notFound = await (
  await fetch(`${base}/dsh-session-cleanup/stat?id=${'session-99999999-9999-9999-9999-999999999999'}`)
).json()
assert.equal(notFound.ok, true)
assert.equal(notFound.exists, false)

await new Promise((resolve) => server.close(resolve))
await rm(home, { recursive: true, force: true })
console.log('\n全部通过')
