import assert from 'node:assert/strict'
import test from 'node:test'

import { REDIRECT_HINT } from '../lib/constants.js'
import { createRuntime } from '../lib/runtime.js'
import {
  createPluginContext,
  installFetch,
  jsonResponse,
  osRoot,
  textResponse,
  twoSourceConfig,
  twoSourceCredentials,
} from './support.mjs'

// Build a runtime over the two-source fixture with a controllable credential
// store. `activeConfig` is a function, exactly like the plugin passes it.
function runtime(cfg = twoSourceConfig(), credentials = twoSourceCredentials()) {
  const { ctx, resolvedRefs } = createPluginContext({ credentials, config: cfg })
  const rt = createRuntime(ctx, () => cfg)
  return { rt, resolvedRefs }
}

async function viewFor(rt, name) {
  return rt.forSource(rt.resolveSource(name))
}

const basicHeader = `Basic ${Buffer.from('prod-user:prod-secret-password').toString('base64')}`

// ── auth header injection (secrets resolved at call time, never returned) ────
test('http injects a Basic header resolved from the credential store', async () => {
  const { rt, resolvedRefs } = runtime()
  const mock = installFetch(() => jsonResponse(osRoot()))
  try {
    const view = await viewFor(rt, 'prod')
    const res = await view.http('GET', '/')
    assert.equal(mock.calls.length, 1)
    assert.equal(mock.calls[0].url, 'https://search-prod.example.com:9200/')
    assert.equal(mock.calls[0].headers.authorization, basicHeader)
    assert.equal(mock.calls[0].headers.accept, 'application/json')
    assert.ok(resolvedRefs.includes('SEARCHOPS_PASSWORD_prod'))
    assert.equal(res.cluster_name, 'searchops-test') // parsed JSON returned
  } finally {
    mock.restore()
  }
})

test('http injects a Bearer token for a bearer-auth source', async () => {
  const { rt, resolvedRefs } = runtime()
  const mock = installFetch(() => jsonResponse(osRoot()))
  try {
    const view = await viewFor(rt, 'staging')
    await view.http('GET', '/')
    assert.equal(mock.calls[0].url, 'https://search-staging.example.com:9200/')
    assert.equal(mock.calls[0].headers.authorization, 'Bearer staging-secret-token')
    assert.ok(resolvedRefs.includes('SEARCHOPS_TOKEN_staging'))
  } finally {
    mock.restore()
  }
})

test('http sends no Authorization header for auth:none', async () => {
  const cfg = { sources: [{ name: 'local', url: 'https://search.example.com', auth: 'none' }] }
  const { rt } = runtime(cfg, {})
  const mock = installFetch(() => jsonResponse(osRoot()))
  try {
    const view = await viewFor(rt, 'local')
    await view.http('GET', '/')
    assert.equal(mock.calls[0].headers.authorization, undefined)
  } finally {
    mock.restore()
  }
})

// ── never send a request without its credential ─────────────────────────────
test('http refuses to reach the network when the password is missing', async () => {
  const { rt } = runtime(twoSourceConfig(), {}) // empty store
  const mock = installFetch(() => jsonResponse(osRoot()))
  try {
    const view = await viewFor(rt, 'prod')
    await assert.rejects(() => view.http('GET', '/'), /needs a password/)
    assert.equal(mock.calls.length, 0) // request never left the process
  } finally {
    mock.restore()
  }
})

test('http refuses a bearer request with no token stored', async () => {
  const { rt } = runtime(twoSourceConfig(), {})
  const mock = installFetch(() => jsonResponse(osRoot()))
  try {
    const view = await viewFor(rt, 'staging')
    await assert.rejects(() => view.http('GET', '/'), /needs a token/)
    assert.equal(mock.calls.length, 0)
  } finally {
    mock.restore()
  }
})

// ── redirect: 'error' — the credential-leak guard ───────────────────────────
test('every request disables redirects so creds cannot cross origins', async () => {
  const { rt } = runtime()
  const mock = installFetch(() => jsonResponse(osRoot()))
  try {
    const view = await viewFor(rt, 'prod')
    await view.http('GET', '/')
    assert.equal(mock.calls[0].redirect, 'error')
  } finally {
    mock.restore()
  }
})

test('a redirect is refused with the security hint and is never followed', async () => {
  const { rt } = runtime()
  const redirectError = () => {
    const e = new TypeError('fetch failed')
    e.cause = new Error('Redirect response received for the request')
    return e
  }
  const mock = installFetch(() => redirectError())
  try {
    const view = await viewFor(rt, 'prod')
    await assert.rejects(() => view.http('GET', '/'), (err) => {
      assert.ok(err.message.startsWith(REDIRECT_HINT))
      assert.match(err.message, /credentials are never forwarded cross-origin/)
      return true
    })
    assert.equal(mock.calls.length, 1) // not followed, not retried
  } finally {
    mock.restore()
  }
})

// ── HTTP failure translation never echoes a secret ──────────────────────────
test('a 401 is translated into guidance without leaking the credential', async () => {
  const { rt } = runtime()
  const mock = installFetch(() => jsonResponse({ error: { type: 'security_exception', reason: 'unauthorized' } }, 401))
  try {
    const view = await viewFor(rt, 'prod')
    await assert.rejects(() => view.http('GET', '/'), (err) => {
      assert.match(err.message, /authentication failed/)
      assert.ok(!err.message.includes('prod-secret-password'))
      assert.ok(!err.message.includes(basicHeader))
      return true
    })
    assert.equal(mock.calls.length, 1) // 401 is not retried
  } finally {
    mock.restore()
  }
})

test('a 200 with a non-JSON body is rejected and its content redacted', async () => {
  const { rt } = runtime()
  // A login gateway echoing the Authorization header — the classic leak trap.
  const mock = installFetch(() => textResponse(`<html>denied Authorization: ${basicHeader}</html>`, 200))
  try {
    const view = await viewFor(rt, 'prod')
    await assert.rejects(() => view.http('GET', '/'), (err) => {
      assert.match(err.message, /non-JSON body/)
      assert.ok(!err.message.includes(basicHeader.split(' ')[1]), 'base64 credential must be redacted')
      return true
    })
  } finally {
    mock.restore()
  }
})

// ── bounded retries: idempotent GET only ────────────────────────────────────
test('a 503 on a GET is retried once and can succeed', async () => {
  const { rt } = runtime()
  const mock = installFetch((url, init, i) => (i === 0 ? jsonResponse({ error: 'down' }, 503) : jsonResponse(osRoot())))
  try {
    const view = await viewFor(rt, 'prod')
    const res = await view.http('GET', '/')
    assert.equal(mock.calls.length, 2)
    assert.equal(res.cluster_name, 'searchops-test')
  } finally {
    mock.restore()
  }
})

test('a 503 on a POST is not retried (writes are never blind-retried)', async () => {
  const { rt } = runtime()
  const mock = installFetch(() => jsonResponse({ error: 'down' }, 503))
  try {
    const view = await viewFor(rt, 'prod')
    await assert.rejects(() => view.http('POST', '/logs/_search', { body: { size: 1 } }), /server error/)
    assert.equal(mock.calls.length, 1)
  } finally {
    mock.restore()
  }
})

// ── per-request timeout ─────────────────────────────────────────────────────
test('http enforces the per-request timeout and reports it as a timeout', async () => {
  const { rt } = runtime()
  // A fetch that never resolves but rejects the moment the signal aborts.
  const hang = (url, init) => new Promise((resolve, reject) => {
    const signal = init?.signal
    const onAbort = () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  const mock = installFetch(hang)
  try {
    const view = await viewFor(rt, 'prod')
    await assert.rejects(() => view.http('GET', '/', {}, { timeoutMs: 20 }), /timed out or was cancelled/)
  } finally {
    mock.restore()
  }
})

// ── response byte cap ───────────────────────────────────────────────────────
test('http enforces the response byte cap', async () => {
  const { rt } = runtime()
  const big = jsonResponse({ blob: 'x'.repeat(4096) })
  const mock = installFetch(() => big)
  try {
    const view = await viewFor(rt, 'prod')
    await assert.rejects(() => view.http('GET', '/', {}, { maxResponseBytes: 64 }), /limit/)
  } finally {
    mock.restore()
  }
})

// ── multiple sources route independently ────────────────────────────────────
test('two sources keep independent URLs, auth and credential refs', async () => {
  const { rt, resolvedRefs } = runtime()
  const mock = installFetch(() => jsonResponse(osRoot()))
  try {
    const prod = await viewFor(rt, 'prod')
    const staging = await viewFor(rt, 'staging')
    await prod.http('GET', '/_cluster/health')
    await staging.http('GET', '/_cluster/health')
    assert.equal(mock.calls[0].url, 'https://search-prod.example.com:9200/_cluster/health')
    assert.equal(mock.calls[1].url, 'https://search-staging.example.com:9200/_cluster/health')
    assert.match(mock.calls[0].headers.authorization, /^Basic /)
    assert.match(mock.calls[1].headers.authorization, /^Bearer /)
    assert.ok(resolvedRefs.includes('SEARCHOPS_PASSWORD_prod'))
    assert.ok(resolvedRefs.includes('SEARCHOPS_TOKEN_staging'))
  } finally {
    mock.restore()
  }
})

// ── listSources is a non-secret projection ──────────────────────────────────
test('listSources reports credentials as booleans and never leaks a value', async () => {
  const { rt } = runtime()
  const list = await rt.listSources()
  assert.equal(list.length, 2)
  const prod = list.find((s) => s.id === 'prod')
  const staging = list.find((s) => s.id === 'staging')
  assert.equal(prod.credentialsConfigured, true)
  assert.equal(prod.isDefault, true)
  assert.equal(staging.auth, 'bearer')
  const serialized = JSON.stringify(list)
  assert.ok(!serialized.includes('prod-secret-password'))
  assert.ok(!serialized.includes('staging-secret-token'))
  assert.ok(!serialized.includes(basicHeader))
})

test('listSources flags a source whose credential is absent', async () => {
  const { rt } = runtime(twoSourceConfig(), {}) // nothing stored
  const list = await rt.listSources()
  assert.equal(list.find((s) => s.id === 'prod').credentialsConfigured, false)
  assert.equal(list.find((s) => s.id === 'staging').credentialsConfigured, false)
})

// ── resolveCredential is a secret sink, never a message source ──────────────
test('resolveCredential returns the value for a known ref and empty for unknown', async () => {
  const { rt } = runtime()
  assert.equal(await rt.resolveCredential('SEARCHOPS_PASSWORD_prod'), 'prod-secret-password')
  assert.equal(await rt.resolveCredential('NOPE'), '')
  assert.equal(await rt.resolveCredential(''), '')
})

// ── URL policy is enforced per source at request time ───────────────────────
test('plain HTTP is refused for a non-loopback host unless explicitly allowed', async () => {
  const cfg = { sources: [{ name: 'insecure', url: 'http://search.example.com', auth: 'none' }] }
  const { rt } = runtime(cfg, {})
  const view = await viewFor(rt, 'insecure')
  await assert.rejects(() => view.http('GET', '/'), /Plain HTTP is disabled/)
})

test('allowInsecureHttp lets an operator opt into plain HTTP', async () => {
  const cfg = { sources: [{ name: 'insecure', url: 'http://search.example.com', auth: 'none' }], allowInsecureHttp: true }
  const { rt } = runtime(cfg, {})
  const mock = installFetch(() => jsonResponse(osRoot()))
  try {
    const view = await viewFor(rt, 'insecure')
    await view.http('GET', '/')
    assert.equal(mock.calls[0].url, 'http://search.example.com/')
  } finally {
    mock.restore()
  }
})
