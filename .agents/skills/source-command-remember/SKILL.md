---
name: "source-command-remember"
description: "Migrated source command `remember`"
---

# source-command-remember

Use this skill when the user asks to run the migrated source command `remember`.

## Command Template

# Remember

Store an important fact in your agent memory for future sessions.

## Usage

```
/remember [category] [fact]
```

## Categories

| Category | Description | Example |
|----------|-------------|---------|
| `preference` | User preferences for how work should be done | "Always use strict TypeScript" |
| `codebase` | Facts about code structure and locations | "The main entry point is src/main/index.ts" |
| `architecture` | Design decisions and their rationale | "We use Zustand because Redux is too verbose" |
| `path` | Important file and folder paths | "Authentication handler is at src/auth/handler.ts" |
| `context` | Current work context | "Working on the memory feature" |

## Examples

```
/remember preference Always use strict TypeScript and enable all strict checks
/remember path The Codex integration is at src/main/services/Codex.service.ts
/remember architecture We use electron-store for persistence to avoid external DB requirements
/remember codebase IPC handlers follow the pattern: src/main/ipc/{domain}.ipc.ts
/remember context Currently implementing the agent memory system
```

## How It Works

When you use `/remember`, the fact is:
1. Stored persistently in electron-store
2. Written to the project's `MEMORY.md` file (if one exists or should be created)
3. Injected into the system prompt at the start of future sessions

## Related Tools

The agent also has access to memory tools that can be called programmatically:

- `remember(category, content)` - Store a memory
- `recall(query)` - Search memories by query
- `forget(factId)` - Remove a memory by ID
- `listMemories()` - List all memories for the current project

## Best Practices

1. **Be specific** - "Authentication uses JWT tokens with RS256" is better than "we use JWT"
2. **Include context** - "The legacy API (v1) uses REST, but v2 uses GraphQL" provides helpful background
3. **Note reasons** - "We avoid lodash because of bundle size concerns" explains the why
4. **Keep it current** - Remove outdated memories using the `forget` tool or editing MEMORY.md

## MEMORY.md File

Memories are also written to a `MEMORY.md` file in the project root or `.Codex/` directory. This file:
- Is human-readable and editable
- Can be committed to git for team sharing
- Is the source of truth for project memories
- Is synced with the database on startup
