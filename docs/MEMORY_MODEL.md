# ProjectMind Memory Model (v1.1.0)

ProjectMind separates **durable truth** from **derived views** and from
**ephemeral task context**. Nothing in the derived layer is allowed to silently
override the event log.

## 1. Append-only event log

Every durable write appends a row to `memory_events`:

| Field | Meaning |
|---|---|
| `event_id` | Unique event id (time-ordered + random suffix) |
| `project_id`, `repository_id`, `branch`, `base_commit` | Repository identity at the time of the write |
| `snapshot_id` | Workspace tree snapshot the event was observed against |
| `actor_type`, `actor_id` | `user`, `agent`, `system`, `hook`, or `cli` plus identity |
| `namespace` | `project/shared`, `project/agent/<id>`, `project/user/<id>`, `project/branch/<name>`, `project/task/<id>` |
| `operation` | `create`, `update`, `delete`, `supersede`, `sync`, `decision`, `task_context`, `conflict`, `merge` |
| `entity_type`, `entity_id` | What changed |
| `payload_json`, `payload_hash` | Canonical payload and its SHA-256 |
| `source_refs` | Files/commits/tests that justify the claim |
| `observed_at`, `ingested_at` | When it was observed vs. when it was written |
| `valid_from`, `valid_to`, `supersedes` | Bi-temporal validity |
| `visibility` | `shared`, `agent-private`, `user-private`, `branch`, `task` |
| `prev_hash`, `event_hash` | SHA-256 hash chain for tamper evidence |

SQLite triggers reject `UPDATE` and `DELETE` on `memory_events`. `get_health`
recomputes the chain and reports the first broken event id.

## 2. Namespaces and visibility

* `project/shared` is visible to every reader.
* `project/agent/<id>` is visible only to that agent identity.
* `project/user/<id>` is visible only to that user.
* `project/branch/<name>` and `project/task/<id>` are scoped drafts.

Retrieval accepts `viewerNamespace` (MCP: `viewerNamespace`) and filters
knowledge/decisions whose namespace is not visible. Writes accept an explicit
`namespace`; defaults are derived from the actor.

## 3. Temporal validity and `asOf`

Knowledge items carry `valid_from`, `valid_to`, `observed_at`, and
`ingested_at`. Superseding an item sets `superseded_by` and `valid_to` and
appends a `supersede` event. Current retrieval excludes superseded/expired rows;
historical retrieval (`asOf`) returns rows whose validity window contains the
requested instant and does not require the row to still be current.

## 4. Optimistic concurrency

A writer may pass `expectedVersion`. If the stored version differs, ProjectMind
does **not** overwrite: it creates a `memory_conflicts` row containing the
current payload and the proposed payload. Conflicts are resolved explicitly via
`resolve_memory_conflict` (merge or reject) with an audit note. Merging applies
the proposal at `currentVersion + 1`.

## 5. Snapshots and freshness contract

A workspace snapshot is the SHA-256 aggregate of `path:full-file-sha256` for
every indexed file, plus git head/branch and a dirty flag. `get_relevant_context`
always:

1. computes the current snapshot and detects changes;
2. refuses to serve a cache entry from a different snapshot or parser/retriever/
   embedder version;
3. returns `snapshot`, `contextContract.mustSyncBeforeEdit`, and a `STALE`
   warning when the workspace changed;
4. includes `why` and `evidence` (path/line) for every retrieval hit.

## 6. What is derived

File records, chunks, symbols, graph edges, modules, FTS rows, cache entries,
and vector embeddings are **derived** and can be rebuilt from source plus the
event log. They are not the source of truth. Vector embeddings are local
feature-hash vectors, explicitly labeled `feature-hash-rerank`.
