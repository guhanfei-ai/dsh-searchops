# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Editable settings form** — the settings page's SearchOps section is now a
  full form (the dsh-grafana settings-card pattern): per-source cards with
  name / URL / auth mode / username / password-or-token / field profile
  inputs, add/remove sources, set-default, a plain-HTTP toggle, and a single
  save that writes secrets first (`remote.credentials.set`, write-only,
  blank keeps the current value) and then the whole config in one
  `remote.settings.mutate` transaction with optimistic revision checking.
  Secret values never enter config rows; ids of hand-written sources are
  synthesized name-derived exactly like the host's `stableIdFromName`.

- **Web sidebar panel** — a client half (`client.js`, no build step, loaded via
  the host ModuleLoader) adds a "SearchOps" button to the conversation header
  that opens a read-only side panel listing every configured source (sanitized
  URL, auth mode, bound field profile, default badge, credentials
  configured/missing) with a per-source connectivity check (cluster name,
  version/distribution, health, node count). Data flows over two loopback
  same-origin RPC endpoints registered by the host half (`lib/rpc.js`):
  `searchops/catalog` and `searchops/status`, reusing the runtime's existing
  sanitized source list and provider ping/health path — credentials remain
  boolean-only, responses stay secret-free and size-capped. On hosts with the
  better-sidebar plugin the panel registers as a native sidebar tab instead;
  otherwise it renders as a self-hosted resizable right-side panel
  (`--dsh-searchops-width`, the dsh-zterm standalone pattern). A
  `settings.section` entry puts the same source overview and connectivity
  check into the settings page's left navigation. The connection
  service is wired through an optional nested inject on both halves: a host
  without it still loads the plugin and the panel shows an upgrade hint.

### Changed

- **0.2.x host compatibility (peer range)** — the `@deepseek-ai/dsh-tools`
  peer range now includes the 0.1.7, 0.2.0 and 0.2.1 lines
  (`^0.1.7-alpha.0 || ^0.2.0-alpha.0 || ^0.2.1-alpha.0`), replacing the
  redundant `^0.1.5-rc.0` branch. From 0.2.0 the host hard-checks plugin
  peers and silently skips non-matching plugins, so without this the plugin
  would not load at all on current hosts. Hosts `0.2.1-rc.2`, `0.2.0-rc.2`,
  `0.1.7-rc.2` and the existing 0.1.x range all satisfy the new peer set;
  `0.3.0` correctly does not. Dev dependency bumped to `0.2.1-rc.2`; every
  settings/tool API surface this plugin uses (tools.register,
  systemPrompt.section, credentials.resolve, settings describe) is unchanged
  on 0.2.1-rc.2.
- **Publish registry pinned** — `publishConfig.registry` now points at
  `https://registry.npmjs.org` explicitly, so publishing from a machine whose
  npm default is a mirror registry is not rejected.

### Fixed

- **`settings.register` guard** — `apply()` no longer assumes the settings
  service exposes `register()`. On pre-0.1.7 hosts it registers the
  `searchops` namespace as before; on 0.1.7+ hosts (where `register`/`scope`
  were removed) it synthesizes the active config from
  `settings.describe()` instead, with the entry config as fallback. Previously
  the unconditional call threw `register is not a function` inside the inject
  callback on 0.1.7+/0.2.0 hosts, which cordis swallowed — leaving settings
  integration dead and spamming err.log.
- **Volatile-marked Config fields** — `sources`, `profiles`, `defaultSource`
  and `allowInsecureHttp` are now marked `.volatile()`. The 0.1.7+ settings
  service only exposes (and accepts writes for) namespaces whose schema has
  volatile fields, so without the markers the searchops namespace was absent
  from `settings.describe()` entirely: neither the generic plugin settings
  page nor any settings UI could edit it. `apply()` unwraps the resulting
  `Volatile` references (`unwrapVolatile`) so every consumer keeps seeing
  plain values.

- **Evidence secret redaction** — documents read back from the cluster are now
  sanitized at a single egress boundary before they reach the model context, a
  tool result or the UI. `sanitizeDocument` redacts credential-shaped field
  *values* by key name (`password`, `passwd`, `pwd`, `secret`, `token`,
  `authorization`, `cookie`, `credential`, `api_key`, `access_token`,
  `refresh_token`, `client_secret`, …, matched case-insensitively across
  snake/camel/kebab and recursed through nested objects and arrays) and obvious
  credential shapes inside strings (`Bearer …`, `Basic …`, `password=…`,
  `api_key=…`, `token=…`, `sk-…`), while preserving the surrounding non-secret
  evidence. It is applied to `searchops_logs`, `searchops_context`,
  `searchops_investigate` samples, `searchops_aggregate` bucket keys and
  `searchops_query` output. This is best-effort and deterministic — not a DLP
  system: it never scrubs arbitrary high-entropy strings, so trace ids and
  innocent fields such as `token_count` or `password_policy_enabled` survive
  intact, and a secret with no recognizable shape can still slip through.
- **Field auto-detection for every log tool** — `searchops_logs`,
  `searchops_context` and `searchops_aggregate` now resolve their field profile
  through the same `explicit profile → mapping auto-detection → convention`
  precedence that `searchops_investigate` already used, via a shared
  `resolveSourceFields` helper. Previously only investigate consulted the mapping,
  so a non-default schema (e.g. `ts` / `msg` / `app`) was silently queried with
  the wrong field names on the other three tools. The mapping is read at most once
  per tool invocation; a mapping failure (timeout, `403`, parse error) degrades
  gracefully to convention instead of failing the call.
- **Truthful `truncated` flag** — `truncated` is no longer a false positive when a
  query simply returned fewer rows than the requested page size. It is set only
  when the total relation proves more matches existed than were returned
  (`total.value > returned` for an exact `eq` count, `>=` for a lower-bound `gte`
  count), so a complete small result (`total=3`, `returned=3`) is correctly
  reported as not truncated.

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
