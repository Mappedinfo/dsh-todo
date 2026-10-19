/**
 * 浏览器 → Host 的 JSON RPC 路由。
 *
 * 通道挂在 webServer 的前缀路由上：Client 用 `ctx.connection.rpc.call`
 * 发起官方信封格式的请求，这里逐字段对齐地回答。
 */

export const RPC_CHANNEL = '/dsh-todo'

const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/
const INVALID_REQUEST_RPC_ID = 'invalid-request'
const MAX_BODY_BYTES = 512 * 1024

function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function asString(value) {
  return typeof value === 'string' ? value : ''
}

function asId(value) {
  const id = asString(value).trim()
  if (id === '') throw new Error('id 不能为空')
  return id
}

function failure(rpcId, code, message) {
  return {
    type: 'server-response',
    rpcId,
    result: { ok: false, error: { code, message, details: { issues: [] } } },
  }
}

function success(rpcId, value) {
  return { type: 'server-response', rpcId, result: { ok: true, value } }
}

/**
 * 端点分发。每个分支都是一次 Host 服务方法的调用：
 * 面板动作与 agent 工具因此共用同一份逻辑与同一份失败原因。
 */
export async function dispatch(api, endpoint, payload) {
  const request = asRecord(payload)
  switch (endpoint) {
    case 'snapshot': {
      const locale = asString(request.locale) || undefined
      const snapshot = api.snapshot()
      return { ...snapshot, markdown: api.markdown(locale) }
    }
    case 'create': {
      const input = asRecord(request.input)
      return { todo: api.create(input) }
    }
    case 'update': {
      const todo = api.update(asId(request.id), asRecord(request.patch))
      return { todo }
    }
    case 'toggle': {
      return { todo: api.toggle(asId(request.id)) }
    }
    case 'remove': {
      return { removed: api.remove(asId(request.id)) }
    }
    case 'clear-completed': {
      return { removed: api.clearCompleted() }
    }
    case 'reorder': {
      api.reorder(Array.isArray(request.ids) ? request.ids.filter((id) => typeof id === 'string') : [])
      return { ok: true }
    }
    case 'save-markdown': {
      const text = asString(request.text)
      const result = api.saveMarkdown(text, asString(request.locale) || undefined)
      return result
    }
    case 'set-prefs': {
      return { prefs: api.setPrefs(asRecord(request.patch)) }
    }
    case 'sweep': {
      return { due: api.sweep().map((todo) => ({ id: todo.id, title: todo.title })) }
    }
    default:
      throw new Error(`unknown endpoint '${endpoint}'`)
  }
}

function endpointFromPath(channel, pathname) {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return undefined
  }
  return endpoint
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function writeJson(res, value) {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

/**
 * 注册 RPC 路由。
 * @returns 释放函数（由调用方在插件卸载时执行）。
 */
export function registerTodoRpc(ctx, api) {
  const route = {
    kind: 'prefix',
    path: RPC_CHANNEL,
    handler: async (req, res) => {
      // 信任栅栏 + 浏览器鉴权：与其他 Web 路由一致。
      const rejection = ctx.connection?.requestRejection?.(req)
      if (rejection !== undefined) {
        res.writeHead(rejection)
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const url = new URL(req.url ?? '/', 'http://dsh.invalid')
      const endpoint = endpointFromPath(RPC_CHANNEL, url.pathname)
      if (endpoint === undefined) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const rawType = req.headers['content-type']
      const mediaType = (Array.isArray(rawType) ? rawType[0] ?? '' : rawType ?? '').split(';')[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') {
        res.writeHead(415)
        res.end('content type must be application/json')
        return
      }
      let body
      try {
        body = await readBody(req)
      } catch {
        res.writeHead(400)
        res.end('body is not JSON')
        return
      }
      const envelope = asRecord(body)
      const rpcId = typeof envelope.rpcId === 'string' ? envelope.rpcId : INVALID_REQUEST_RPC_ID
      if (envelope.type !== 'client-request' || typeof envelope.method !== 'string') {
        writeJson(res, failure(rpcId, 'gateway/bad-request', 'invalid client-request message'))
        return
      }
      if (envelope.method !== endpoint) {
        writeJson(res, failure(rpcId, 'gateway/bad-request', `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(endpoint)}`))
        return
      }
      try {
        writeJson(res, success(rpcId, await dispatch(api, endpoint, envelope.payload)))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const badRequest = /不能为空|不存在|必须是|格式应/.test(message)
        writeJson(res, failure(rpcId, badRequest ? 'bad-request' : 'internal', message))
      }
    },
  }
  const dispose = ctx.effect(() => ctx.webServer.register(route), 'dsh-todo: rpc route')
  return async () => {
    if (typeof dispose === 'function') await dispose()
  }
}