---
name: projectmind
description: >-
  Automatically retrieves persistent project architecture, module context, and dependency impact
  via ProjectMind MCP tools, and synchronizes project memory after code edits. Use whenever
  working on a software repository, planning a new project from a prompt, modifying modules,
  debugging, or making architectural decisions.
---
# ProjectMind — Automatic Project Intelligence Skill

1. **When to Use ProjectMind vs. Skip It**: Use ProjectMind whenever working on this repository. Skip for unrelated general questions.
2. **Initial Project Encounter**: Call `get_project_status` or `get_relevant_context`. If `initialized: false`, call `initialize_project`.
3. **Selective Context Retrieval**: Call `get_relevant_context` instead of scanning every file manually.
4. **Synchronizing Memory After Changes**: Call `sync_changed_files` after editing files, and `record_architectural_decision` when establishing architectural choices.
