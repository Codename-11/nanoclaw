# User Profile — Codename_11

## Identity
- Handle: Codename_11
- Platform: Discord (main channel)

## Projects
- **SubFrame** — terminal-first IDE for AI coding tools (Claude Code, Codex CLI, Gemini CLI)
  - GitHub: https://github.com/Codename-11/SubFrame
  - Site: https://sub-frame.dev
  - Status: Public beta (v0.1.0-beta.3), Windows primary tested, macOS/Linux less tested
  - Stack: Electron 28, React 19, TypeScript (strict), Zustand, Tailwind CSS, xterm.js, node-pty
  - Origin: Grew from Frame (frame.cool) by kaanozhan — different direction, significant additions
  - Key features: Structure Map, Agent Activity Monitor, Health Dashboard, Sub-Task Management, Multi-AI support, Hooks & Automation
- **NanoClaw** — Personal AI assistant (Daemon), actively enhancing and customizing

## Working Style
- Direct and concise — doesn't like fluff
- Likes acknowledgement before long tasks ("reply before running off")
- Wants progress updates during long work (Mini-Daemon streaming)
- Prefers things done first, reminded after
- Comfortable with technical depth
- Tests things iteratively ("try it", "try again")
- Casual tone in chat, no need for formality

## Preferences
- Assistant name: Daemon (changed from Andy, permanently)
- Likes visual output — charts, diagrams, embeds over plain text
- Wants file attachments when possible vs pasting text
- Appreciates honest, direct feedback (not just praise)

## Wishlist / Feature Requests for Daemon
- Delete Discord messages capability
- SVG/image generation (SVGMaker MCP or Recraft API)
- Faster response time with instant typing acknowledgement (✅ typing indicator done, refresh loop pending)
- Receive attachments from user (currently one-way — Daemon can send, not receive)
- Response streaming — send chunks as Claude generates rather than waiting for full response

## NanoClaw Architecture Vision
- *Daemon = persistent container* — main agent stays alive permanently, always listening, no cold start
- *Ephemeral containers = tools/subtasks* — Mini-Daemon, web browsing, bash tasks spin up and die as needed (as originally intended)
- This eliminates: cold start latency, typing indicator gap, "not a persistent agent" problem

### Persistent Container Bundle (do all at once)
When implementing persistent Daemon container, bundle these in the same build:
1. *Persistent container* — Daemon stays alive, no per-message cold start
2. *SOUL.md* — personality/identity file loaded at boot (see OpenClaw pattern)
   - 3 files: SOUL.md (personality/values), IDENTITY.md (name/appearance), MEMORY.md (long-term context)
   - Lives in Daemon's workspace, read at every session start
   - Defines: tone, opinions, how to handle disagreement, what Daemon cares about
   - Inspired by OpenClaw's soul system (github.com/aaronjmars/soul.md)
   - Draft soul based on existing Codename_11 conversations — authentic, not generic
3. *Typing refresh loop* — `setInterval(sendTyping, 7000)` cleared when response sends, eliminates dead zone
4. *Response streaming* — stream Claude output chunks to Discord as they generate
5. *Container pre-warming* — fallback if full persistence isn't feasible immediately

### Interim fixes already done
- ✅ sendTyping() fires immediately on message receipt (Mini-Daemon build)

## Key Context
- Aware of Frame (frame.cool) as SubFrame's origin — wants it acknowledged tastefully, not as focus
- Planning to post SubFrame on r/ClaudeAI and r/ClaudeCode (Reddit post draft saved at subframe-reddit-post.md)
- Values open source, community-driven development

## Remind Me
- **Discord as project management platform** — when doing tasks/builds, proactively use Discord as the update layer: post progress, results, and summaries as embeds/messages. Treat Discord like a PM dashboard, not just a chat window. Remind user of this idea when kicking off bigger tasks.

## Last Updated: 2026-03-08
