// test/rpc.test.js — Sidebar panel RPC: handler semantics over a stub runtime
// plus the connection.fetch route wiring (envelope, content type, size caps).
import assert from 'node:assert/strict'
import test from 'node:test'

import { RPC_METHODS, RPC_PREFIX, createRpcHandler, registerSearchopsRpc } from '../lib/rpc.js'

function stubRuntime(overrides = {}) {
  return {
    listSources: overrides.listSources ?? (async () => [{ id: 's1', name: 'prod', provider: 'opensearch', url: 'https://search.example.com:9200', auth: 'basic', profile: '(auto-detect)', credentialsConfigured: true, isDefault: true }]),
    resolveSource: overrides.resolveSource ?? ((name) => ({ name: name ?? 'prod' })),
    forSource: overrides.forSource ?? (() => ({
      provider: {
        ping: overrides.ping ?? (async () => ({ clusterName: 'c', version: '2.11.0', distribution: 'opensearch' })),
        clusterHealth: overrides.health ?? (async () => ({ clusterName: 'c', status: 'green', numberOfNodes: 3 })),
      },
    })),
  }
}

function post(route, body, headers = {}) {
  return route.fetch(new Request(`http://localhost/api/${RPC_PREFIX}/x`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }))
}

// ── createRpcHandler ────────────────────────────────────────────────────────
test('catalog returns the sanitized source list from the runtime', async () => {
  const handler = createRpcHandler(stubRuntime())
  const result = await handler('catalog', {}, new AbortController().signal)
  assert.equal(result.ok, true)
  assert.equal(result.value.sources.length, 1)
  assert.equal(result.value.sources[0].name, 'prod')
  assert.equal(result.value.sources[0].credentialsConfigured, true)
  assert.ok(!('password' in result.value.sources[0]) && !('token' in result.value.sources[0]))
})

test('status pings and reads cluster health for the resolved source', async () => {
  let pingedWith
  const rt = stubRuntime({
    resolveSource: (name) => ({ name }),
    forSource: (source) => ({
      provider: {
        ping: async (opts) => { pingedWith = { source: source.name, opts } ; return { version: '2.11.0', distribution: 'opensearch' } },
        clusterHealth: async () => ({ status: 'yellow', clusterName: 'staging', numberOfNodes: 1 }),
      },
    }),
  })
  const handler = createRpcHandler(rt)
  const result = await handler('status', { source: 'staging' }, new AbortController().signal)
  assert.equal(result.ok, true)
  assert.equal(result.value.source, 'staging')
  assert.equal(result.value.health.status, 'yellow')
  assert.equal(pingedWith.source, 'staging')
  assert.equal(pingedWith.opts.signal.aborted, false)
  assert.equal(typeof pingedWith.opts.timeoutMs, 'number')
})

test('status failure becomes a classified, single-line, capped error envelope', async () => {
  const boom = new Error('cluster unreachable:\nupstream said "no" '.repeat(40))
  const handler = createRpcHandler(stubRuntime({
    ping: async () => { throw boom },
  }))
  const result = await handler('status', { source: 'prod' }, new AbortController().signal)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'request_failed')
  assert.ok(!result.error.message.includes('\n'), 'message must be single-lined')
  assert.ok(result.error.message.length <= 300, 'message must be capped')
  assert.ok(result.error.message.includes('cluster unreachable'))
})

test('unknown method and aborted signal are rejected without touching the runtime', async () => {
  let touched = false
  const handler = createRpcHandler({ listSources: async () => { touched = true; return [] } })
  const unknown = await handler('nope', {}, new AbortController().signal)
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'unknown_method')
  const aborted = new AbortController()
  aborted.abort()
  const result = await handler('catalog', {}, aborted.signal)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'aborted')
  assert.equal(touched, false)
})

// ── registerSearchopsRpc ────────────────────────────────────────────────────
function wiredConnection() {
  const routes = new Map()
  return {
    routes,
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    },
  }
}

function fakeEffectCtx() {
  const disposables = []
  return {
    ctx: { effect(fn) { const dispose = fn(); disposables.push(dispose); return dispose } },
    disposeAll() { for (const dispose of disposables.splice(0)) dispose?.() },
  }
}

test('registers one POST route per method and disposes cleanly', () => {
  const { routes, connection } = wiredConnection()
  const { ctx, disposeAll } = fakeEffectCtx()
  const dispose = registerSearchopsRpc(ctx, connection, stubRuntime())
  for (const method of RPC_METHODS) {
    const route = routes.get(`/api/${RPC_PREFIX}/${method}`)
    assert.ok(route, `route for ${method}`)
    assert.deepEqual(route.methods, ['POST'])
  }
  dispose()
  disposeAll()
  assert.equal(routes.size, 0)
})

test('register is a no-op when the connection service has no fetch.register', () => {
  const { ctx } = fakeEffectCtx()
  assert.equal(typeof registerSearchopsRpc(ctx, {}, stubRuntime()), 'function')
  assert.equal(typeof registerSearchopsRpc(ctx, undefined, stubRuntime()), 'function')
})

test('route rejects wrong content type, bad JSON and malformed envelopes', async () => {
  const { routes, connection } = wiredConnection()
  const { ctx } = fakeEffectCtx()
  registerSearchopsRpc(ctx, connection, stubRuntime())
  const route = routes.get(`/api/${RPC_PREFIX}/catalog`)

  const text = await post(route, 'hello', { 'content-type': 'text/plain' })
  assert.equal(text.status, 415)
  const badJson = await post(route, '{not json')
  assert.equal(badJson.status, 400)
  const wrongMethod = await post(route, { type: 'client-request', rpcId: 'r1', method: 'searchops/status' })
  assert.equal(wrongMethod.status, 400)
  const missingRpcId = await post(route, { type: 'client-request', method: 'searchops/catalog' })
  assert.equal(missingRpcId.status, 400)
})

test('route answers a valid envelope with a server-response carrying the result', async () => {
  const { routes, connection } = wiredConnection()
  const { ctx } = fakeEffectCtx()
  registerSearchopsRpc(ctx, connection, stubRuntime())
  const route = routes.get(`/api/${RPC_PREFIX}/catalog`)
  const response = await post(route, { type: 'client-request', rpcId: 'req-1', method: 'searchops/catalog', payload: {} })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.type, 'server-response')
  assert.equal(body.rpcId, 'req-1')
  assert.equal(body.result.ok, true)
  assert.equal(body.result.value.sources[0].name, 'prod')

  const failing = routes.get(`/api/${RPC_PREFIX}/status`)
  const rt = stubRuntime({ ping: async () => { throw new Error('down') } })
  // rewire: register a second wired connection against the failing runtime
  const second = wiredConnection()
  const ctx2 = fakeEffectCtx()
  registerSearchopsRpc(ctx2.ctx, second.connection, rt)
  const response2 = await post(second.routes.get(`/api/${RPC_PREFIX}/status`), { type: 'client-request', rpcId: 'req-2', method: 'searchops/status', payload: { source: 'prod' } })
  const body2 = await response2.json()
  assert.equal(body2.result.ok, false)
  assert.equal(body2.result.error.code, 'request_failed')
  void failing
})
