/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const data = {
      type: 'schedule_task',
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    const filename = writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

server.tool(
  'send_attachment',
  'Send a file attachment to the user or group. The file must exist in your workspace (/workspace/group/ or /workspace/ipc/). Use this to share generated files, images, reports, etc.',
  {
    file_path: z.string().describe('Absolute path to the file inside the container (e.g., /workspace/group/report.pdf)'),
    caption: z.string().optional().describe('Optional text caption to display with the attachment'),
  },
  async (args) => {
    if (!fs.existsSync(args.file_path)) {
      return {
        content: [{ type: 'text' as const, text: `File not found: ${args.file_path}` }],
        isError: true,
      };
    }

    const data = {
      type: 'attachment',
      chatJid,
      filePath: args.file_path,
      caption: args.caption || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: `Attachment sent: ${args.file_path}` }] };
  },
);

server.tool(
  'send_embed',
  'Send a rich embed message (Discord only). Creates a structured card with title, description, fields, colors, and images.',
  {
    title: z.string().optional().describe('Embed title'),
    description: z.string().optional().describe('Embed body text (supports markdown)'),
    color: z.number().optional().describe('Color as decimal integer (e.g., 5814783 for blue, 16711680 for red, 65280 for green)'),
    fields: z.array(z.object({
      name: z.string(),
      value: z.string(),
      inline: z.boolean().optional(),
    })).optional().describe('Structured fields displayed in the embed'),
    thumbnail: z.string().optional().describe('URL of thumbnail image'),
    image: z.string().optional().describe('URL of large image'),
    footer: z.string().optional().describe('Footer text'),
    url: z.string().optional().describe('URL the title links to'),
  },
  async (args) => {
    const data = {
      type: 'embed',
      chatJid,
      embed: {
        title: args.title,
        description: args.description,
        color: args.color,
        fields: args.fields,
        thumbnail: args.thumbnail,
        image: args.image,
        footer: args.footer,
        url: args.url,
      },
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Embed sent.' }] };
  },
);

server.tool(
  'self_build',
  'Spawn a Claude Code session on the host to modify NanoClaw\'s own codebase. Main group only. ' +
  'A sidecar "Builder" identity will send progress updates to chat while working. ' +
  'Changes are made on a safety branch with automatic build+test validation and rollback on failure. ' +
  'On success, changes are merged and nanoclaw restarts automatically. ' +
  'Use this when the user asks you to modify your own code, add features, fix bugs, or enhance NanoClaw.',
  {
    prompt: z.string().describe(
      'Detailed instructions for what Claude Code should do. Be specific about files, patterns, and desired behavior. ' +
      'ALWAYS include: "After code changes, update CLAUDE.md, docs/SPEC.md, and groups/main/CLAUDE.md with any new capabilities. ' +
      'If MCP tools were added/changed in container/agent-runner/src/ipc-mcp-stdio.ts, run: rm -rf data/sessions/*/agent-runner-src"',
    ),
    timeout_minutes: z.number().optional().describe('Max duration in minutes (default: 10, max: 30)'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can run self-build sessions.' }],
        isError: true,
      };
    }

    const data = {
      type: 'run_claude_session',
      prompt: args.prompt,
      timeout: args.timeout_minutes
        ? Math.min(args.timeout_minutes, 30) * 60_000
        : undefined,
      chatJid,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{
        type: 'text' as const,
        text: 'Self-build session requested. Builder will send progress updates to chat. ' +
          'Changes will be validated (build + test) before merging. Service restarts automatically on success.',
      }],
    };
  },
);

server.tool(
  'run_host_command',
  'Run a predefined command on the host machine. Main group only. Allowed commands: "update" (git pull + npm install + build), "restart" (restart nanoclaw service), "status" (git log + service status).',
  {
    command: z.enum(['update', 'restart', 'status']).describe('The host command to run'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can run host commands.' }],
        isError: true,
      };
    }

    const data = {
      type: 'run_host_command',
      prompt: args.command,
      chatJid,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Host command "${args.command}" requested. Output will be sent to chat.` }] };
  },
);

server.tool(
  'change_model',
  'Change the AI model used for future agent invocations. Main group only. Takes effect on the next container spawn (not the current session). Common models: claude-sonnet-4-6, claude-opus-4-6, claude-haiku-4-5-20251001.',
  {
    model: z.string().describe('Model ID (e.g., "claude-sonnet-4-6", "claude-opus-4-6")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can change the model.' }],
        isError: true,
      };
    }

    // Write a task to update .env on the host
    const data = {
      type: 'change_model',
      model: args.model,
      chatJid,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Model change to "${args.model}" requested. Will take effect on next invocation.` }] };
  },
);

server.tool(
  'get_system_info',
  'Get information about the current system: model, version, capabilities, and runtime status.',
  {},
  async () => {
    const model = process.env.CLAUDE_MODEL || 'default (not set)';
    const version = (() => {
      try {
        const pkg = JSON.parse(fs.readFileSync('/workspace/project/package.json', 'utf-8'));
        return pkg.version || 'unknown';
      } catch {
        return 'unknown';
      }
    })();

    const info = {
      model,
      nanoclaw_version: version,
      group: groupFolder,
      chat_jid: chatJid,
      is_main: isMain,
      capabilities: [
        'send_message',
        'send_attachment',
        'send_embed',
        'schedule_task',
        'list_tasks',
        'register_group',
        ...(isMain ? ['run_host_command', 'change_model'] : []),
      ],
      container: {
        workspace: '/workspace/group',
        ipc: '/workspace/ipc',
        has_project_access: isMain && fs.existsSync('/workspace/project'),
      },
    };

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(info, null, 2) }],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
