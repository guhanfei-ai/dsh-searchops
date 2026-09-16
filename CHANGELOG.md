# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — initial release

First public version of **dsh-searchops**: an agent-native search, log
investigation and cluster-operations layer for DeepSeek Harness. OpenSearch-first,
provider-neutral by design. Strictly **read-only**.

### Added

- **Nine `searchops_*` tools**, all read-only and bounded:
  - `searchops_sources` — list configured sources (names, providers, sanitized
    URLs, auth mode, bound profile, credentials-configured, default). Never
    returns a secret.
  - `searchops_status` — reachability plus cluster health, version, distribution,
    node and shard counts.
  - `searchops_indices` — list indices by pattern, paged, with doc counts and
    store sizes.
  - `searchops_mapping` — inspect an index's fields (flattened `{path, type}`), or
    a bounded raw-mapping mode.
  - `searchops_query` — bounded raw query DSL for power users.
  - `searchops_logs` — semantic log search by time range, service, level and free
    text without knowing field names.
  - `searchops_aggregate` — group/count/metric and date-histogram over an index
    without pulling documents.
  - `searchops_context` — the lines around one event (by timestamp) or every event
    sharing a trace id.
  - `searchops_investigate` — a fixed, bounded investigation returning a
    structured evidence package (patterns, representative events, correlated
    traces, suggested next queries).
- **Provider abstraction** — a provider-neutral `SearchProvider` contract
  (`ping`, `clusterHealth`, `listIndices`, `getMapping`, `search`) with a registry
  and a single OpenSearch adapter. Elasticsearch is a reserved extension point; no
  fake adapter ships.
- **Multiple named sources** — up to 50, each with its own URL, auth mode
  (`none` / `basic` / `bearer`), credential references and field profile. Every
  tool takes an optional `source` argument.
- **Configurable field profiles with auto-detection** — `timestampField`,
  `messageField`, `serviceField`, `levelField`, `traceIdField`, resolved as
  profile → detection → convention. No log schema is hard-coded.
- **Deterministic log fingerprinting** — collapses volatile tokens (timestamps,
  UUIDs, IP:port, long hex/number ids) so recurring errors group into one pattern
  with a count, without ML and without being over-aggressive.
- **Friendly time ranges** — ISO-8601, `now`, and OpenSearch date math
  (`now-15m`, `now-1h`, `now-24h`), shape-validated and window-bounded.
- **A categorized, secret-free error model** — auth, permission, bad query,
  missing index, timeout, oversized response, unsupported provider, configuration
  and network/TLS failures are distinguished and made actionable.
- **Documentation** — `README.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`.
- **Tests** — `node:test` suites covering config parsing, credential redaction,
  source selection, provider request building, status/indices/mapping, query size
  and timeout limits, logs query construction, time ranges, field profiles,
  aggregation, context, error-pattern normalization, investigate evidence
  grouping, response truncation, auth-error sanitization, redirect credential
  safety, malformed responses, untrusted-data handling and multiple sources. All
  run against an in-process HTTP mock with no public-service dependency.

### Security

- **Read-only by construction** — no write, delete, mapping-change, cluster-setting
  or bulk path; no generic `searchops_http` proxy.
- **Credential isolation** — references in config, values resolved per request
  into the `Authorization` header only; literal secrets in config are rejected;
  sources list reports credentials as a boolean.
- **Redirects disabled** (`redirect: 'error'`) so credentials are never forwarded
  cross-origin.
- **Transport policy** — HTTPS required for non-loopback hosts; plain HTTP refused
  unless `allowInsecureHttp: true`; URLs with embedded credentials, query strings
  or fragments rejected; certificate validation never disabled.
- **Bounded responses** — per-request timeout, streamed hard byte cap, size and
  offset limits, and a maximum time window, with explicit truncation disclosure.
- **Untrusted-data handling** — all returned content is single-lined, truncated
  and structured, and is never interpreted as instructions.
- **Secret redaction** — upstream bodies and error fragments are redacted before
  surfacing; request headers are never printed.

### Known limitations

- OpenSearch only; Elasticsearch is not implemented.
- No deep pagination (`search_after` not exposed); offsets past 10 000 are
  rejected.
- No AWS SigV4 (basic, bearer and no-auth only) — on the roadmap.
- Date math is forwarded and shape-validated, not parsed locally.
- Field auto-detection is best-effort; unusual schemas should bind an explicit
  profile.

[0.1.0]: https://github.com/guhanfei-ai/dsh-searchops/releases/tag/v0.1.0
