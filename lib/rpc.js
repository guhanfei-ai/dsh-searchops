// lib/rpc.js — Loopback same-origin RPC endpoints that back the web client
// sidebar panel (same envelope contract as the zterm plugin, trimmed to two
// read-only methods):
//   POST /api/searchops/catalog — sanitized source list (never secret values)
//   POST /api/searchops/status  — reachability + cluster health for one source
//
// Security invariants, identical to the tools': responses are sanitized and
// secret-free (credentials are reported only as booleans; upstream failures go
// through the same classified, redacted translation the tools use), requests
// are size-capped, and nothing here writes cluster state.
import { REQUEST_TIMEOUT_MS } from './constants.js'
import { oneLine } from './util.js'

export const RPC_PREFIX = 'searchops'
export const RPC_METHODS = Object.freeze(['catalog', 'status'])

const MAX_RPC_BODY_BYTES = 128 * 1024

// OneLine + hard cap as a final egress guard on error text: upstream messages
// are already classified/redacted by the provider layer, but the wire must be
// provably bounded even if a failure path invents a new message.
function safeMessage(error, fallback) {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const text = oneLine(raw).trim()
  return (text || fallback).slice(0, 300)
}

// Pure handler over the runtime seam: (method, payload, signal) -> result
// envelope { ok, value } | { ok: false, error: { code, message } }. Kept free
// of cordis/connection types so tests can drive it with a stub runtime.
export function createRpcHandler(rt) {
  return async function handler(method, payload, signal) {
    if (signal?.aborted) {
      return { ok: false, error: { code: 'aborted', message: 'Request aborted' } }
    }
    try {
      if (method === 'catalog') {
        return { ok: true, value: { sources: await rt.listSources() } }
      }
      if (method === 'status') {
        const name = typeof payload?.source === 'string' ? payload.source.trim() : ''
        const source = rt.resolveSource(name || undefined)
        const view = rt.forSource(source)
        const opts = { signal, timeoutMs: REQUEST_TIMEOUT_MS }
        const [info, health] = await Promise.all([
          view.provider.ping(opts),
          view.provider.clusterHealth(opts),
        ])
        return { ok: true, value: { source: source.name, info, health } }
      }
      return { ok: false, error: { code: 'unknown_method', message: `unknown searchops RPC method "${method}"` } }
    } catch (error) {
      return { ok: false, error: { code: 'request_failed', message: safeMessage(error, 'request failed') } }
    }
  }
}

// Register the per-method fetch routes on the host connection service.
// Returns a disposer; a no-op disposer when the service shape is unfamiliar
// (older hosts), so the plugin still loads and the panel degrades to its
// "host too old" hint instead of killing the whole fiber.
export function registerSearchopsRpc(ctx, connection, rt) {
  const register = connection?.fetch?.register
  if (typeof register !== 'function') return () => {}
  const handler = createRpcHandler(rt)
  const disposers = []
  for (const method of RPC_METHODS) {
    const fullMethod = `${RPC_PREFIX}/${method}`
    disposers.push(ctx.effect(() => register({
      path: `/api/${fullMethod}`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
          return new Response('content type must be application/json', { status: 415 })
        }
        let message
        try {
          const body = await request.text()
          if (body.length > MAX_RPC_BODY_BYTES) return new Response('request is too large', { status: 413 })
          message = JSON.parse(body)
        } catch {
          return new Response('body is not JSON', { status: 400 })
        }
        if (message?.type !== 'client-request'
          || typeof message.rpcId !== 'string' || !message.rpcId || message.rpcId.length > 256
          || message.method !== fullMethod) {
          return new Response('invalid client-request envelope', { status: 400 })
        }
        const result = await handler(method, message.payload, request.signal)
        return Response.json({ type: 'server-response', rpcId: message.rpcId, result })
      },
    })))
  }
  return () => {
    for (const dispose of disposers) dispose?.()
    disposers.length = 0
  }
}
