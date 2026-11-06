# ProjectMind Implementation Status

This document separates what is **implemented and covered by tests** from what is
**experimental** and what is **planned**. It exists to prevent documentation from
presenting a specification as a shipped guarantee.

Last updated: 2026-11-06 · Engine version: 1.1.0 · Test suite: 89 checks

| Area | Status | Evidence / notes |
|---|---|---|
| 3-layer memory schema (v4) | Implemented | SQLite migrations v1→v4; `tests/core`, `tests/memory` |
| Append-only memory events + hash chain | Implemented | `memory_events` triggers reject UPDATE/DELETE; chain verified by `get_health` and tests |
| Workspace snapshots and index manifest | Implemented | `workspace_snapshots`, `index_manifest`; snapshot id bound into every context package |
| Snapshot-aware retrieval cache | Implemented | Change detection runs before cache lookup; cache key includes snapshot/parser/retrieval/embedder versions; regression test in benchmark and core |
| Full-file SHA-256 + chunk hashes | Implemented | Streamed hashing; tail-of-large-file change test in `tests/indexing` |
| TypeScript/JavaScript AST extraction | Implemented | `@babel/parser`; symbols, imports, re-exports, routes, SQL tables |
| tsconfig/workspace import resolution | Implemented | Relative paths, workspace package names, `paths` aliases; tested |
| File-level code graph | Implemented | `code_graph_edges`, `code_symbols`; graph expansion in retrieval |
| Module dependency/impact analysis | Implemented | Derived from resolved edges; existing tests plus benchmark |
| Hybrid retrieval (FTS + symbols + graph + vector rerank) | Implemented | Per-hit score breakdown, matched terms, `why`, and evidence |
| Local vector backend | Experimental (lexical) | `hash-feature-v2` feature hashing, 192 dims. **Not** a learned semantic embedding. A real provider can be injected via `KnowledgeRetriever.setSemanticProvider` |
| Namespaces (shared/agent/user/branch/task) | Implemented | `project/shared`, `project/agent/<id>`, etc.; visibility enforced in retrieval; tested |
| Optimistic concurrency + conflict proposals | Implemented | `expectedVersions` → `memory_conflicts`; merge/reject API and MCP tools; tested |
| Bi-temporal memory and `asOf` retrieval | Implemented | `valid_from`/`valid_to` on knowledge, `asOf` on search/context; tested |
| Historical decisions | Partial | `asOf` includes decisions valid at that time; supersession timestamp is not yet a separate decision field |
| Secure plugin updater | Implemented | HTTPS + host allowlist, mandatory SHA-256, tar path/symlink/size limits, manifest file hashes, atomic package install, rollback, smoke verification; tested |
| Core updater | Implemented for non-git installs | Stages a verified archive and applies atomically; refuses to overwrite a git checkout (use `git pull`) |
| 9 agent adapters | Implemented | Install/verify/uninstall/update tests; downloaded package assets are applied to skill/instruction files |
| MCP tools | Implemented | 27 tools, including health, event log, conflicts, `asOf`, namespaces |
| CLI | Implemented | `health`, `manifest`, `memory events`, `memory conflicts`, real `update` flow |
| Benchmark | Implemented (synthetic) | `npm run benchmark`: Recall@1/3/5, MRR, explainability coverage, latency, stale-hit checks |
| Clean-room reproducibility | Implemented | CI extracts the release archive, `npm ci`, builds, tests, and benchmarks |
| Python bridge portability | Implemented | Resolves `python3`, `python`, or `py -3`; CI matrix covers Linux/macOS/Windows |
| Learned local embeddings backend | Planned | Requires an optional model/runtime; not claimed or enabled |
| Tree-sitter/deep parsing for Python/Go/Rust/Java | Planned | These languages currently use regex fallbacks and are labeled `regex-fallback-v1` |
| Real-repository retrieval evaluation | Planned | Benchmark fixture is synthetic; no claim of accuracy on arbitrary large monorepos |
| Encryption at rest | Planned | SQLite file relies on OS/filesystem permissions today |
| Retention/compaction/TTL | Planned | Events are append-only by design; no automatic forget/compaction yet |
| Signed releases (Sigstore/minisign) | Planned | SHA-256 + GitHub release integrity today; artifact signatures are a future hardening step |
| File watcher daemon | Planned | CLI/manual and agent-hook sync only |
| Branch-aware automatic namespaces | Partial | Namespace format and APIs exist; automatic branch switching is not wired into every workflow |
| Multi-process shared memory server | Planned | SQLite WAL + event lock serialize local writers; no network daemon |

## Verification commands

```bash
npm ci
npm run build
npm test          # 89 checks
npm run benchmark # Recall@k, MRR, freshness, latency
npm run release:package
```

The release CI job additionally extracts `projectmind-full.tar.gz` into a clean
directory, runs `npm ci`, builds, tests, and benchmarks **that extracted copy**.

## Known limits of the current test evidence

* Tests use synthetic fixtures; they prove behavior on those scenarios, not
  accuracy on every real repository.
* Retrieval latency in the benchmark is dominated by the Python SQLite bridge;
  the hot path is batched, but a persistent bridge would be faster.
* Analysis reads up to 2 MiB per file for symbol extraction. Larger files are
  still fully hashed and marked `analysisStatus: "truncated"` instead of being
  silently trusted.
* Regex fallbacks remain for non-TS/JS languages; their parser version is
  recorded so callers can see the difference.
