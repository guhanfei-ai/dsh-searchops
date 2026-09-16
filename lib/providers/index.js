// lib/providers/index.js — The provider registry and the SearchProvider contract.
//
// A SearchProvider is the single seam between the provider-neutral SearchOps
// core and a concrete search backend. The core (logs/aggregate/context/
// investigate) only ever talks to this interface, so `opensearch.*` never leaks
// into the domain layer. Adding a backend means adding one adapter here.
//
// SearchProvider (all methods return provider-neutral, JSON-safe shapes):
//   ping()                       -> { clusterName, version, tagline? }
//   clusterHealth()              -> { status, clusterName, numberOfNodes, ... }  (bounded)
//   listIndices({pattern,limit}) -> { indices:[{index,health,status,docsCount,storeSize}], truncated, total }
//   getMapping({index,maxFields})-> { indices:[{index,fields:[{path,type}],fieldCount,truncated}], truncated }
//   search({index,body})         -> { hits:[{id,index,source,sort?}], total:{value,relation}, took, timedOut, aggregations? }
//
// The `body` for search is the OpenSearch/Elasticsearch query DSL (the shared
// lingua franca of this provider family); a non-DSL backend would translate
// internally behind the same method signatures.
import { PROVIDER_OPENSEARCH, RESERVED_PROVIDERS, SUPPORTED_PROVIDERS } from '../constants.js'
import { createOpenSearchProvider } from './opensearch.js'

// name -> factory(deps) where deps = { http } and `http` is the runtime-supplied
// authenticated, bounded, redirect-disabled HTTP function.
const REGISTRY = {
  [PROVIDER_OPENSEARCH]: createOpenSearchProvider,
}

export function isSupportedProvider(name) {
  return SUPPORTED_PROVIDERS.has(String(name ?? '').trim().toLowerCase())
}

// Instantiate a provider adapter by name. Unknown names produce a clear,
// secret-free error that also names the reserved-but-unimplemented providers so
// the agent does not assume they exist.
export function createProvider(name, deps) {
  const key = String(name ?? '').trim().toLowerCase()
  const factory = REGISTRY[key]
  if (!factory) {
    const reserved = RESERVED_PROVIDERS.includes(key)
      ? ` ${key[0].toUpperCase()}${key.slice(1)} is planned but not implemented in v0.1 — do not configure it yet.`
      : ''
    throw new Error(`Unsupported search provider ${JSON.stringify(name)}. Supported in v0.1: ${[...SUPPORTED_PROVIDERS].join(', ')}.${reserved}`)
  }
  return factory(deps)
}

export { createOpenSearchProvider }
