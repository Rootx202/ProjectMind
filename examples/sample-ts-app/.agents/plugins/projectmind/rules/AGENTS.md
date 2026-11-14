<!-- PROJECTMIND:START -->
## ProjectMind — Automatic Project Intelligence
This repository uses **ProjectMind** for persistent project memory and selective context retrieval:
1. Before planning or coding a repository task, call `get_relevant_context` (or `initialize_project` if uninitialized) instead of scanning all files.
2. Before modifying shared modules or schemas, call `get_module_context` or `analyze_change_impact`.
3. After modifying, adding, renaming, or deleting files, call `sync_changed_files` (and `record_architectural_decision` when architectural choices are made).
4. Skip ProjectMind calls for general questions unrelated to this codebase.
<!-- PROJECTMIND:END -->
