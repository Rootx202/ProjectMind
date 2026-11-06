# ProjectMind Security & Privacy Architecture

ProjectMind is designed with a strict **local-first, privacy-by-design** security model. This document details the security principles, safeguards, and threat mitigations implemented across the platform.

---

## 1. Core Security Principles

1. **Zero External Network Calls**:
   ProjectMind runs 100% locally on your machine. It makes **zero** outbound HTTP requests, includes **zero** telemetry or tracking code, and never transmits your source code or project intelligence to any cloud service.
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

## 5. Plugin Integrity & Verification

All distributed plugins include SHA-256 cryptographic checksums:
* Manifests contain an `integrity.hash` field.
* Release archives in `dist/plugins/` are signed in `SHA256SUMS`.
* `projectmind plugin verify <agent>` verifies that installed configuration files, hook runners, and MCP configs match expected integrity checks.

---

## 6. Reporting a Security Vulnerability

If you discover a security vulnerability in ProjectMind:
1. Please do **NOT** open a public GitHub issue.
2. Send an email with vulnerability details, proof-of-concept, and environment information to:
   **security@projectmind.dev**
3. We acknowledge reports within 48 hours and provide a fix or mitigation timeline promptly.

