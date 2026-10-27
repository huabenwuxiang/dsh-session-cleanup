/**
 * dsh-session-cleanup — host 半侧。
 *
 * 只做一件事：把一条会话从磁盘上真正删掉，并把它从 workspace 登记里摘出去。
 * 没有对外依赖（只用 node: 内置模块），所以本地目录安装时不需要 pnpm 解析任何包。
 */
import { readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

export const name = 'dsh-session-cleanup'

/** webServer 提供 HTTP 路由；workspaceRegistry 用来把会话从工作区登记里摘掉；agents 用来挡住在跑的会话。 */
export const inject = ['webServer', 'workspaceRegistry', 'agents']

const ROUTE_PREFIX = '/dsh-session-cleanup'
const SESSION_ID_RE = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_BODY_BYTES = 64 * 1024
const MAX_WALK_ENTRIES = 200000

class CleanupError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

/** DSH 的根目录：DSH_HOME > ~/.dsh（与 dsh-home-paths 的优先级一致）。 */
function dshHome() {
  const configured = (process.env.DSH_HOME ?? '').trim()
  return configured ? resolve(configured) : join(homedir(), '.dsh')
}

function sessionsRoot() {
  return join(dshHome(), 'sessions')
}

function projCacheDir() {
  return join(dshHome(), 'storages', 'session_projcache', 'sessions')
}

function assertSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
    throw new CleanupError('INVALID_SESSION_ID', '会话 ID 不合法。')
  }
  return sessionId
}

/** 在所有工作区的会话目录里找出这个会话（正常情况下最多一个）。 */
async function collectSessionDirs(sessionId) {
  const root = sessionsRoot()
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const dirs = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = join(root, entry.name, sessionId)
    if (!candidate.startsWith(root + sep)) continue
    try {
      const info = await stat(candidate)
      if (info.isDirectory()) dirs.push(candidate)
    } catch {
      // 不存在就跳过
    }
  }
  return dirs
}

/** 递归统计一个目录的字节数和文件数（只用于向用户展示，出错就按已知部分算）。 */
async function measureDir(dir) {
  let bytes = 0
  let files = 0
  let seen = 0
  const stack = [dir]
  while (stack.length > 0 && seen < MAX_WALK_ENTRIES) {
    const current = stack.pop()
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      seen += 1
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      try {
        const info = await stat(full)
        bytes += info.size
        files += 1
      } catch {
        // 忽略统计不到的项
      }
    }
  }
  return { bytes, files }
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 找出这个会话所属的 workspace 实体（可能为零个：Ungrouped）。 */
function findOwners(ctx, sessionId) {
  let registry
  try {
    registry = ctx.workspaceRegistry
  } catch {
    return []
  }
  if (!registry || typeof registry.list !== 'function') return []
  const owners = []
  for (const workspace of registry.list()) {
    const ids = workspace?.sessionIds
    if (Array.isArray(ids) && ids.includes(sessionId)) owners.push(workspace)
  }
  return owners
}

/** 会话是否还活着（当前打开或正在跑）。活着就不允许删，避免删掉正在写的日志。 */
function liveAgent(ctx, sessionId) {
  try {
    const registry = ctx.agents
    if (!registry || typeof registry.get !== 'function') return undefined
    return registry.get(sessionId)
  } catch {
    return undefined
  }
}

/**
 * 删除一条会话：会话目录 + 投影缓存 + workspace 登记里的席位。
 * @returns {{removedBytes:number, removedFiles:number, removedDirs:number, detached:number, warnings:string[]}}
 */
export async function removeSession(ctx, rawSessionId) {
  const sessionId = assertSessionId(rawSessionId)

  if (liveAgent(ctx, sessionId)) {
    throw new CleanupError(
      'SESSION_LIVE',
      '这条对话仍在使用中（当前打开或正在运行）。先切换到别的对话、等它停下来，再回来删除。',
      409,
    )
  }

  const dirs = await collectSessionDirs(sessionId)
  const cacheFile = join(projCacheDir(), `${sessionId}.json`)
  const hasCache = await exists(cacheFile)
  if (dirs.length === 0 && !hasCache) {
    throw new CleanupError('NOT_FOUND', '磁盘上找不到这条对话，可能已经被删掉了。', 404)
  }

  let removedBytes = 0
  let removedFiles = 0
  for (const dir of dirs) {
    const measured = await measureDir(dir)
    removedBytes += measured.bytes
    removedFiles += measured.files
  }

  // 先删缓存、再删日志目录：缓存被占用时直接失败，至少不会留下“日志没了、索引还在”的半截状态。
  try {
    await rm(cacheFile, { force: true, maxRetries: 3, retryDelay: 120 })
    for (const dir of dirs) {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 })
    }
  } catch (error) {
    if (error?.code === 'EBUSY' || error?.code === 'EPERM' || error?.code === 'EACCES') {
      throw new CleanupError(
        'SESSION_LOCKED',
        '文件被占用，删除没有完成。请先关闭/切换这条对话，必要时重启 DSH 再试。',
        409,
      )
    }
    throw new CleanupError('IO_ERROR', `删除文件失败：${error?.message ?? String(error)}`, 500)
  }

  const warnings = []
  const owners = findOwners(ctx, sessionId)
  let detached = 0
  for (const workspace of owners) {
    try {
      await workspace.detachSession(sessionId)
      detached += 1
    } catch (error) {
      warnings.push(`从工作区登记移除失败：${error?.message ?? String(error)}`)
    }
  }

  return {
    removedBytes,
    removedFiles,
    removedDirs: dirs.length,
    detached,
    warnings,
  }
}

/** 删除前的预检：占用多少、属于哪个工作区、是否还活着。 */
export async function inspectSession(ctx, rawSessionId) {
  const sessionId = assertSessionId(rawSessionId)
  const dirs = await collectSessionDirs(sessionId)
  let bytes = 0
  let files = 0
  for (const dir of dirs) {
    const measured = await measureDir(dir)
    bytes += measured.bytes
    files += measured.files
  }
  const owners = findOwners(ctx, sessionId)
  return {
    exists: dirs.length > 0,
    bytes,
    files,
    live: Boolean(liveAgent(ctx, sessionId)),
    workspaces: owners.map((workspace) => ({ id: workspace.id, title: workspace.title })),
  }
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new CleanupError('BODY_TOO_LARGE', '请求体过大。', 413)
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new CleanupError('BAD_JSON', '请求体不是合法的 JSON。')
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function fail(res, error) {
  if (error instanceof CleanupError) {
    sendJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: error?.message ?? String(error) } })
}

async function handleRequest(ctx, req, res) {
  const url = new URL(req.url ?? '/', 'http://dsh.local')
  const path = url.pathname

  // 只接受同源调用：别的网页发起的跨源请求一律拒绝。
  const origin = req.headers.origin
  if (origin) {
    let sameOrigin = false
    try {
      sameOrigin = new URL(origin).host === req.headers.host
    } catch {
      sameOrigin = false
    }
    if (!sameOrigin) {
      sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: '仅允许同源调用。' } })
      return
    }
  }

  if (req.method === 'GET' && path === `${ROUTE_PREFIX}/health`) {
    sendJson(res, 200, { ok: true, version: '0.1.0', home: dshHome() })
    return
  }

  if (req.method === 'GET' && path === `${ROUTE_PREFIX}/stat`) {
    const info = await inspectSession(ctx, url.searchParams.get('id') ?? '')
    sendJson(res, 200, { ok: true, ...info })
    return
  }

  if (req.method === 'POST' && path === `${ROUTE_PREFIX}/delete`) {
    const body = await readJsonBody(req)
    const result = await removeSession(ctx, body?.sessionId ?? '')
    sendJson(res, 200, { ok: true, ...result })
    return
  }

  sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '未知路由。' } })
}

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          try {
            await handleRequest(ctx, req, res)
          } catch (error) {
            fail(res, error)
          }
        },
      }),
    'dsh-session-cleanup: routes',
  )
  ctx.logger?.info?.(`[session-cleanup] 删除路由已挂载：${ROUTE_PREFIX}（home=${dshHome()}）`)
}

/** 仅供自测脚本使用。 */
export const __test = { collectSessionDirs, measureDir, inspectSession, removeSession, dshHome }
