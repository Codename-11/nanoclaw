# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Discord Enhanced Capabilities

The Discord channel supports rich messaging beyond plain text:

- **Attachments (send):** `Channel.sendAttachment(jid, filePath, caption?)` — agents send files via IPC `type: "attachment"`
- **Attachments (receive):** Incoming attachments are downloaded to `data/ipc/{group}/input/` and accessible at `/workspace/ipc/input/{filename}` inside the container
- **Rich Embeds:** `Channel.sendEmbed(jid, embed)` — structured cards with title, description, color, fields, images. IPC `type: "embed"`
- **Thread Support:** Messages from threads route to the parent channel's group; replies go back to the thread automatically
- **Self-Update:** IPC `type: "run_host_command"` (main-only) supports `update`, `restart`, `status` commands
- **Self-Build:** IPC `type: "run_claude_session"` (main-only) spawns a Claude Code sidecar ("Builder") on the host to modify NanoClaw's own codebase with git safety, build validation, and auto-rollback

Discord bot requires these permissions: Send Messages, Read Message History, View Channels, Attach Files, Embed Links, Send Messages in Threads.

## Container Agent Capabilities

- **Self-Diagnostics:** `mcp__nanoclaw__self_diagnose` — agents can check their own health (recent log errors/warnings, IPC queue depth, disk usage, task state, CLAUDE.md status). Runs locally inside the container with no IPC needed.

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
