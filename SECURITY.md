# ProjectMind Security & Privacy Architecture

ProjectMind is designed with a strict **local-first, privacy-by-design** security model. This document details the security principles, safeguards, and threat mitigations implemented across the platform.

---

## 1. Core Security Principles

1. **No Telemetry, Explicit Network Only**:
   Indexing, retrieval, and memory writes run 100% locally and make no network
   requests. ProjectMind contains **zero** telemetry or tracking code and never
   transmits source code or project intelligence to a cloud service. The only
   outbound requests are made when the user explicitly runs `projectmind update`,
   `projectmind update check`, or `projectmind plugin update/outdated`, which
   contact GitHub Releases to fetch a version manifest or a verified artifact.
2. **Zero Plaintext Secret Ingestion**:
   ProjectMind's indexing engine explicitly excludes credential files, private keys, environment files, and sensitive tokens. Detected secrets are scrubbed before indexing.
3. **Workspace Boundary Isolation**:
   ProjectMind strictly restricts its file read and write operations to the active project workspace root. Path traversal attacks (e.g. `../../etc/passwd`) and malicious symlink escapes outside the project directory are blocked.
4. **Prompt Injection Defense**:
   Untrusted repository content (such as third-party dependencies, user comments, or downloaded test files) is sanitized before being returned to AI coding agents to prevent indirect prompt injection.
5. **Non-Destructive Operations**:
   Plugin installation, updates, and removals use atomic writes, automatic backups, and never delete persistent project databases.

---

## 2. Secret Exclusion Engine

Before any file is read or indexed into ProjectMind memory, it passes through the multi-layer security filter in `@projectmind/shared`:

### File Path Exclusion List
The following patterns are unconditionally ignored during indexing:
* `.env`, `.env.*` (e.g. `.env.production`, `.env.local`)
* `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.pkcs12`
* `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`
* `credentials.json`, `service-account*.json`
* `.git/`, `.svn/`, `.hg/`
* `node_modules/`, `vendor/`, `target/`, `dist/`, `build/`
* Any path matching repository `.gitignore` specifications

### Content Secret Redactor
If an indexed file contains credential patterns (such as AWS access keys, GitHub personal access tokens, OpenAI/Anthropic API keys, JWT tokens, or RSA headers), they are automatically redacted with `[REDACTED_SECRET]` before storage or context generation.

---

## 3. Path Traversal & Symlink Escape Mitigation

ProjectMind validates all file paths requested via MCP tools or CLI arguments using `resolveSafeProjectPath`:

```text
User Input: "../../etc/shadow"
      |
      v
[Resolve Canonical Path via fs.realpathSync]
      |
      v
[Path Within Verified projectRoot?]
      |
   +--+--+
   |     |
  No    Yes
   |     |
   |     +--> Safe Execution
   v
Access Denied (PathTraversalError)
```

1. Resolves all symbolic links to real physical filesystem targets.
2. Verifies that the resolved path is located strictly within the normalized `projectRoot`.
3. If a symlink points outside the workspace root, access is rejected immediately.

---

## 4. Hook Execution Safety & Isolation

ProjectMind executes lifecycle hooks via thin, portable wrappers:
* **Timeout Protection**: Stdin reads and engine processing enforce a strict 5000ms timeout guard to prevent hanging processes.
* **Fail-Open Policy**: If ProjectMind experiences an unexpected exception (e.g. database locked by another process), it logs diagnostic information to `stderr` and returns an empty JSON object to the agent, allowing the user's coding session to proceed without interruption.
* **Channel Separation**: Diagnostic logs are strictly routed to `stderr` and never written to `stdout`, preventing JSON-RPC parsing corruption in agents.

---

## 5. Update & Artifact Verification

ProjectMind treats every downloaded update as untrusted input.

### Transport
* Update URLs must use **HTTPS**; plain HTTP is refused unless
  `PROJECTMIND_ALLOW_INSECURE_UPDATES=1` is explicitly set for local testing.
* Downloads and redirects are restricted to an allowlist
  (`api.github.com`, `github.com`, `objects.githubusercontent.com`, etc.).
* Redirect chains are limited to 3 hops and may not downgrade to HTTP.
* Response bodies are capped (64 MiB) and time out after 20 seconds.

### Integrity
* A **SHA-256 is mandatory** for plugin and core artifacts. Missing checksums are
  a hard failure; `PROJECTMIND_ALLOW_UNVERIFIED_UPDATES=1` exists only for
  development and must not be used in production.
* Comparisons use `crypto.timingSafeEqual`.
* Plugin archives contain a `manifest.json` that lists **every file with its
  SHA-256**. Missing, mismatched, or undeclared files fail validation.
* `SHA256SUMS` and `index.json` are published with each GitHub Release.

### Archive hardening
The tar.gz extractor rejects:
* absolute paths, `..` traversal, Windows drive prefixes, and null bytes;
* symlinks, hardlinks, devices, and unsupported entry types;
* archives exceeding entry-count, per-file, total-size, or compressed-size limits.

### Install & rollback
* A verified plugin bundle is extracted to staging, installed atomically under
  `.projectmind/plugins/<id>/versions/<version>`, and recorded with its artifact
  SHA-256 in `state.json`.
* The adapter is re-run with the verified package's `assets/instructions.md` and
  `assets/SKILL.md`; if verification fails, the previous package pointer is
  restored and the installer is re-run.
* Core updates are staged and verified; `applyCoreUpdate` refuses to overwrite a
  git checkout (use `git pull`) unless explicitly forced.

### Not yet implemented
Artifact **signatures** (Sigstore/minisign) are not implemented. Integrity
currently relies on SHA-256 values published in the same GitHub release channel.
This is documented as a planned hardening step, not a shipped guarantee.

## 6. Shared Memory Trust Boundaries

* Every durable write carries `actor_type`, `actor_id`, `namespace`, `snapshot_id`,
  and (where relevant) `source_refs`.
* `memory_events` is append-only: SQLite triggers reject `UPDATE` and `DELETE`,
  and a SHA-256 hash chain is verified by `projectmind health`.
* Namespaces prevent one agent from reading another agent's or user's private
  memory (`project/agent/<id>`, `project/user/<id>`).
* Concurrent writers use optimistic concurrency; a stale `expectedVersion`
  produces a reviewable conflict instead of a silent overwrite.
* Repository content is evidence, not instructions. Sanitization strips prompt
  injection patterns and redacts secrets before content enters retrieval output.
* Stale snapshots cannot be served from cache: contexts carry a snapshot id and
  `mustSyncBeforeEdit`, and the cache is invalidated on unsynchronized changes.

### Data-flow contract

| Operation | Network | Leaves the machine | Notes |
|---|---|---|---|
| Bootstrap / sync / retrieval | None | No | Local SQLite only |
| `get_relevant_context` | None | No | Local retrieval |
| `update check` / `plugin outdated` | GitHub API | Version metadata only | No source/context |
| `update` / `plugin update` | GitHub Releases | No project data | Verified artifact download |
| `/health`, `memory events` | None | No | Local diagnostics |

## 7. Reporting a Security Vulnerability

If you discover a security vulnerability in ProjectMind:
1. Please do **NOT** open a public GitHub issue.
2. Send an email with vulnerability details, proof-of-concept, and environment information to:
   **security@projectmind.dev**
3. We acknowledge reports within 48 hours and provide a fix or mitigation timeline promptly.

