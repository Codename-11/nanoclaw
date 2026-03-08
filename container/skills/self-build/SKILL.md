# Self-Build

Modify NanoClaw's own codebase by spawning a **Mini-Daemon** sidecar — an interactive Claude Code session on the host that streams progress to Discord and can be talked to.

## When to Use

When the user asks you to:
- Add features to NanoClaw itself
- Fix bugs in your own code
- Change your behavior at the code level
- Add new MCP tools, IPC handlers, or channel capabilities
- Refactor or improve NanoClaw internals

## How It Works

1. You call `mcp__nanoclaw__self_build` with a detailed prompt
2. **Mini-Daemon** (🔧) spawns on the host and appears in chat as a sidecar
3. Mini-Daemon streams what it's doing — batched updates every 5s, not per-tool-call
4. The user can talk to Mini-Daemon directly during the session (messages are forwarded)
5. When done, Mini-Daemon validates (build + test), merges on success, rolls back on failure
6. NanoClaw restarts automatically with the new code

## Writing Good Prompts

Be specific. Mini-Daemon has full access to the NanoClaw codebase but no conversation context. Include:
- Exact file paths and function names when known
- The pattern to follow (reference existing code)
- What the expected behavior should be
- Any constraints or edge cases

**IMPORTANT: Always include these instructions in every self-build prompt:**

> After making code changes, also update all relevant documentation:
> - `CLAUDE.md` — if new features, capabilities, or key files were added
> - `docs/SPEC.md` — if Channel interface, IPC types, or architecture changed
> - `groups/main/CLAUDE.md` — if new MCP tools or capabilities were added that Daemon should know about
> - `container/skills/self-build/SKILL.md` — only if self-build behavior itself changed
> - If new MCP tools were added to `container/agent-runner/src/ipc-mcp-stdio.ts`, also clear cached copies: `rm -rf data/sessions/*/agent-runner-src`

Good prompt example:
"In src/channels/discord.ts, add a method `sendReaction(jid, messageId, emoji)` that calls the Discord API to add a reaction. Add the method to the Channel interface in src/types.ts as optional. Add handling in src/ipc.ts for a new IPC type 'reaction' with fields chatJid, messageId, emoji. Add the MCP tool in container/agent-runner/src/ipc-mcp-stdio.ts following the send_attachment pattern. Update CLAUDE.md, docs/SPEC.md, and groups/main/CLAUDE.md with the new capability. Clear cached agent-runner copies."

Bad: "Add reaction support"

## Interacting with Mini-Daemon

During a build session, any messages sent to the main channel are forwarded to Mini-Daemon. You can:
- Ask it questions about what it's doing
- Give it corrections or additional instructions
- Tell it to stop or change approach

## Safety

- Git safety branch created before any changes
- `npm run build && npm test` must pass before merge
- Auto-rollback on any failure
- Concurrency lock: one session at a time
- Main group only
- 10 minute default timeout (max 30)

## After Success

NanoClaw restarts automatically. The cached agent-runner copies in `data/sessions/*/agent-runner-src/` may need clearing if MCP tools were changed — Mini-Daemon should handle this.
