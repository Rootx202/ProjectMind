---
name: projectmind
description: >-
  Automatically retrieves persistent project architecture, module context, and dependency impact
  via ProjectMind MCP tools, and synchronizes project memory after code edits. Use whenever
  working on a software repository, planning a new project from a prompt, modifying modules,
  debugging, or making architectural decisions.
---
# ProjectMind — Automatic Project Intelligence Skill

1. **When to Use**: Use ProjectMind for any task involving this repository's architecture, modules, APIs, database models, or code edits. Skip for unrelated general questions.
2. **Initialization**: If `get_project_status` reports `initialized: false`, call `initialize_project` (`mode: "existing"` for existing codebases, or `mode: "prompt"` with `promptText` for new projects from specifications).
3. **Selective Retrieval**: Call `get_relevant_context` with `taskDescription` and optional `targetFiles`/`targetModules`. Never read every file in the repository manually.
4. **Impact & Sync**: Use `analyze_change_impact` for cross-module changes, and always call `sync_changed_files` after modifying files.
