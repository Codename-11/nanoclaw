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
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
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
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

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

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
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
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
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
  'add_reaction',
  'Add an emoji reaction to a message in the chat. Use standard emoji or custom Discord emoji format.',
  {
    message_id: z.string().describe('The Discord message ID to react to'),
    emoji: z.string().describe('Emoji to react with (e.g., "\ud83d\udc4d", "\u2764\ufe0f", "\ud83c\udf89")'),
  },
  async (args) => {
    const data = {
      type: 'reaction',
      chatJid,
      messageId: args.message_id,
      emoji: args.emoji,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: `Reaction ${args.emoji} added to message ${args.message_id}.` }] };
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
    model: z.string().optional().describe('Model for Mini-Daemon to use (e.g., "claude-sonnet-4-6", "claude-opus-4-6"). Defaults to Claude Code default.'),
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
      model: args.model || undefined,
      timeout: args.timeout_minutes
        ? Math.min(args.timeout_minutes, 30) * 60_000
        : undefined,
      chatJid,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    const sessionRef = `build-${Date.now()}`;
    return {
      content: [{
        type: 'text' as const,
        text: `Self-build session requested (ref: ${sessionRef}). Builder will post a 🔧 message within ~10 seconds when online. ` +
          'Progress updates stream to chat. Changes validated (build + test) before merging. ' +
          'Use self_build_status to check progress. Service restarts automatically on success.',
      }],
    };
  },
);

server.tool(
  'self_build_status',
  'Check Mini-Daemon self-build status, including live build log. Main group only. Use tail_lines to control log output (default 50, 0 = no log, -1 = full log).',
  {
    tail_lines: z.number().optional().describe('Number of log lines to return from the end (default 50, 0 = no log, -1 = full log)'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can check self-build status.' }],
        isError: true,
      };
    }

    const statusFile = path.join(IPC_DIR, 'self_build_status.json');
    const logFile = path.join(IPC_DIR, 'self_build_log.txt');
    try {
      let status: Record<string, unknown> = { active: false, status: 'no_session', detail: 'No self-build session has been run.' };
      if (fs.existsSync(statusFile)) {
        status = JSON.parse(fs.readFileSync(statusFile, 'utf-8'));
      }

      // Read build log if requested
      const tailLines = args.tail_lines ?? 50;
      let log = '';
      if (tailLines !== 0 && fs.existsSync(logFile)) {
        const fullLog = fs.readFileSync(logFile, 'utf-8');
        if (tailLines === -1) {
          log = fullLog;
        } else {
          const lines = fullLog.split('\n');
          log = lines.slice(-tailLines).join('\n');
        }
      }

      const result: Record<string, unknown> = { ...status };
      if (log) {
        result.log = log;
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading build status: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'self_build_message',
  'Send a message to the active Mini-Daemon builder session. Use this to give corrections, additional instructions, or ask questions during a build. Main group only.',
  {
    message: z.string().describe('Message to send to Mini-Daemon'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can message Mini-Daemon.' }],
        isError: true,
      };
    }

    const taskData = {
      type: 'forward_to_builder',
      message: args.message,
      chatJid,
      groupFolder,
    };

    const taskFile = path.join(IPC_DIR, 'tasks', `build_msg_${Date.now()}.json`);
    fs.writeFileSync(taskFile, JSON.stringify(taskData));

    return {
      content: [{ type: 'text' as const, text: 'Message sent to Mini-Daemon. It will appear in the builder\'s stdin as a follow-up instruction.' }],
    };
  },
);

server.tool(
  'self_build_cancel',
  'Cancel the active Mini-Daemon builder session. Kills the process and cleans up the worktree. Main group only.',
  {},
  async () => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can cancel builds.' }],
        isError: true,
      };
    }

    const taskData = {
      type: 'cancel_build',
      chatJid,
      groupFolder,
    };

    const taskFile = path.join(IPC_DIR, 'tasks', `build_cancel_${Date.now()}.json`);
    fs.writeFileSync(taskFile, JSON.stringify(taskData));

    return {
      content: [{ type: 'text' as const, text: 'Cancel request sent. Mini-Daemon will be terminated and the worktree cleaned up.' }],
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
        ...(isMain ? ['run_host_command', 'change_model', 'self_build', 'self_build_status', 'self_build_message', 'self_build_cancel'] : []),
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

server.tool(
  'self_diagnose',
  'Run a self-diagnostic check. Scans recent container logs for errors/warnings, checks IPC queue health, reports disk usage, reads current tasks, and verifies CLAUDE.md. No IPC needed — reads local container files only.',
  {},
  async () => {
    const report: {
      timestamp: string;
      logs: { file: string; errors: string[]; warnings: string[] }[];
      ipc_queue: { pending_messages: number; pending_tasks: number };
      disk_usage: { path: string; size_bytes: number | null; error?: string };
      current_tasks: { count: number; tasks: unknown[] | null; error?: string };
      claude_md: { exists: boolean; size_bytes: number | null; path: string };
      overall_status: 'healthy' | 'degraded' | 'error';
      issues: string[];
    } = {
      timestamp: new Date().toISOString(),
      logs: [],
      ipc_queue: { pending_messages: 0, pending_tasks: 0 },
      disk_usage: { path: '/workspace/group/', size_bytes: null },
      current_tasks: { count: 0, tasks: null },
      claude_md: { exists: false, size_bytes: null, path: '/workspace/group/CLAUDE.md' },
      overall_status: 'healthy',
      issues: [],
    };

    // 1. Scan recent log files for errors/warnings
    const logsDir = '/workspace/group/logs/';
    try {
      if (fs.existsSync(logsDir)) {
        const logFiles = fs.readdirSync(logsDir)
          .filter((f: string) => f.endsWith('.log'))
          .sort()
          .slice(-3); // last 3 log files

        for (const file of logFiles) {
          const logPath = path.join(logsDir, file);
          const content = fs.readFileSync(logPath, 'utf-8');
          const lines = content.split('\n');
          const errors: string[] = [];
          const warnings: string[] = [];

          for (const line of lines) {
            const lower = line.toLowerCase();
            if (lower.includes('error') || lower.includes('exception') || lower.includes('fatal')) {
              errors.push(line.trim().slice(0, 200));
            } else if (lower.includes('warn')) {
              warnings.push(line.trim().slice(0, 200));
            }
          }

          report.logs.push({
            file,
            errors: errors.slice(-10), // last 10 errors per file
            warnings: warnings.slice(-10),
          });

          if (errors.length > 0) {
            report.issues.push(`${errors.length} error(s) found in ${file}`);
          }
        }
      } else {
        report.issues.push('Logs directory not found at ' + logsDir);
      }
    } catch (err) {
      report.issues.push(`Failed to read logs: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 2. Check IPC queue health
    try {
      if (fs.existsSync(MESSAGES_DIR)) {
        const msgFiles = fs.readdirSync(MESSAGES_DIR).filter((f: string) => f.endsWith('.json'));
        report.ipc_queue.pending_messages = msgFiles.length;
        if (msgFiles.length > 10) {
          report.issues.push(`${msgFiles.length} pending IPC messages (possible backlog)`);
        }
      }
    } catch { /* ignore */ }

    try {
      if (fs.existsSync(TASKS_DIR)) {
        const taskFiles = fs.readdirSync(TASKS_DIR).filter((f: string) => f.endsWith('.json'));
        report.ipc_queue.pending_tasks = taskFiles.length;
        if (taskFiles.length > 10) {
          report.issues.push(`${taskFiles.length} pending IPC tasks (possible backlog)`);
        }
      }
    } catch { /* ignore */ }

    // 3. Disk usage of /workspace/group/
    try {
      const { execSync } = await import('child_process');
      const duOutput = execSync('du -sb /workspace/group/ 2>/dev/null || echo "0\t/workspace/group/"', { encoding: 'utf-8' });
      const sizeStr = duOutput.split('\t')[0].trim();
      report.disk_usage.size_bytes = parseInt(sizeStr, 10) || 0;
    } catch (err) {
      report.disk_usage.error = err instanceof Error ? err.message : String(err);
    }

    // 4. Read current tasks
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');
    try {
      if (fs.existsSync(tasksFile)) {
        const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
        report.current_tasks.count = Array.isArray(tasks) ? tasks.length : 0;
        report.current_tasks.tasks = tasks;
      }
    } catch (err) {
      report.current_tasks.error = err instanceof Error ? err.message : String(err);
      report.issues.push('Failed to read current_tasks.json');
    }

    // 5. Check CLAUDE.md
    const claudeMdPath = '/workspace/group/CLAUDE.md';
    try {
      if (fs.existsSync(claudeMdPath)) {
        const stat = fs.statSync(claudeMdPath);
        report.claude_md.exists = true;
        report.claude_md.size_bytes = stat.size;
        if (stat.size === 0) {
          report.issues.push('CLAUDE.md exists but is empty');
        }
      } else {
        report.issues.push('CLAUDE.md not found — group has no memory file');
      }
    } catch { /* ignore */ }

    // 6. Determine overall status
    if (report.issues.length === 0) {
      report.overall_status = 'healthy';
    } else if (report.issues.some(i => i.includes('error') || i.includes('Failed'))) {
      report.overall_status = 'error';
    } else {
      report.overall_status = 'degraded';
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }],
    };
  },
);

// --- Discord Admin Tools (main group only) ---

const ADMIN_RESULT_FILE = path.join(IPC_DIR, 'admin_result.json');

/**
 * Write an admin IPC request and poll for the result file.
 * Returns the parsed result or throws on timeout.
 */
async function adminIpcCall(data: object, timeoutMs = 10000): Promise<Record<string, unknown>> {
  // Clean up any stale result file
  try { fs.unlinkSync(ADMIN_RESULT_FILE); } catch { /* ignore */ }

  writeIpcFile(MESSAGES_DIR, data);

  // Poll for result
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 300));
    if (fs.existsSync(ADMIN_RESULT_FILE)) {
      const result = JSON.parse(fs.readFileSync(ADMIN_RESULT_FILE, 'utf-8'));
      try { fs.unlinkSync(ADMIN_RESULT_FILE); } catch { /* ignore */ }
      return result;
    }
  }
  throw new Error('Admin IPC call timed out');
}

server.tool(
  'discord_delete_message',
  'Delete a specific Discord message by channel and message ID. Main group only.',
  {
    channel_id: z.string().describe('The Discord channel ID'),
    message_id: z.string().describe('The Discord message ID to delete'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can use Discord admin tools.' }], isError: true };
    }
    try {
      writeIpcFile(MESSAGES_DIR, {
        type: 'discord_delete_message',
        channelId: args.channel_id,
        messageId: args.message_id,
        chatJid,
        groupFolder,
        timestamp: new Date().toISOString(),
      });
      return { content: [{ type: 'text' as const, text: `Message ${args.message_id} deleted from channel ${args.channel_id}.` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed to delete message: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'discord_delete_messages',
  'Bulk delete the last N messages from a Discord channel (up to 100). Only works on messages less than 14 days old. Main group only.',
  {
    channel_id: z.string().describe('The Discord channel ID'),
    count: z.number().min(1).max(100).describe('Number of recent messages to delete (1-100)'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can use Discord admin tools.' }], isError: true };
    }
    try {
      const result = await adminIpcCall({
        type: 'discord_delete_messages',
        channelId: args.channel_id,
        count: args.count,
        chatJid,
        groupFolder,
        timestamp: new Date().toISOString(),
      });
      return { content: [{ type: 'text' as const, text: `Deleted ${result.deleted} messages from channel ${args.channel_id}.` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed to bulk delete: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'discord_create_channel',
  'Create a new Discord channel in the server. Main group only.',
  {
    name: z.string().describe('Channel name (lowercase, hyphens)'),
    type: z.enum(['text', 'voice', 'category']).default('text').describe('Channel type'),
    topic: z.string().optional().describe('Channel topic (text channels only)'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can use Discord admin tools.' }], isError: true };
    }
    try {
      const result = await adminIpcCall({
        type: 'discord_create_channel',
        channelName: args.name,
        channelType: args.type,
        topic: args.topic,
        chatJid,
        groupFolder,
        timestamp: new Date().toISOString(),
      });
      return { content: [{ type: 'text' as const, text: `Channel created: ${result.name} (ID: ${result.id})` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed to create channel: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'discord_edit_channel',
  'Edit a Discord channel\'s name or topic. Main group only.',
  {
    channel_id: z.string().describe('The Discord channel ID to edit'),
    name: z.string().optional().describe('New channel name'),
    topic: z.string().optional().describe('New channel topic'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can use Discord admin tools.' }], isError: true };
    }
    try {
      writeIpcFile(MESSAGES_DIR, {
        type: 'discord_edit_channel',
        channelId: args.channel_id,
        channelName: args.name,
        topic: args.topic,
        chatJid,
        groupFolder,
        timestamp: new Date().toISOString(),
      });
      return { content: [{ type: 'text' as const, text: `Channel ${args.channel_id} edit requested.` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed to edit channel: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'discord_get_members',
  'List all members in the Discord server. Returns ID, username, display name, and bot status. Main group only.',
  {},
  async () => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can use Discord admin tools.' }], isError: true };
    }
    try {
      const result = await adminIpcCall({
        type: 'discord_get_members',
        chatJid,
        groupFolder,
        timestamp: new Date().toISOString(),
      });
      const members = result.members as { id: string; username: string; displayName: string; bot: boolean }[];
      const formatted = members
        .map((m) => `- ${m.displayName} (@${m.username}, ID: ${m.id})${m.bot ? ' [BOT]' : ''}`)
        .join('\n');
      return { content: [{ type: 'text' as const, text: `Server members (${members.length}):\n${formatted}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed to get members: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
