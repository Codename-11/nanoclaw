import { ChildProcess, exec, execSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { readEnvFile } from './env.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  builderSendEmbed,
  builderSendMessage,
  connectBuilderBot,
  disconnectBuilderBot,
} from './builder-bot.js';
import { EmbedData, RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendAttachment?: (
    jid: string,
    filePath: string,
    caption?: string,
  ) => Promise<void>;
  sendEmbed?: (jid: string, embed: EmbedData) => Promise<void>;
  addReaction?: (
    jid: string,
    messageId: string,
    emoji: string,
  ) => Promise<void>;
  deleteMessage?: (channelId: string, messageId: string) => Promise<void>;
  deleteMessages?: (channelId: string, count: number) => Promise<number>;
  createChannel?: (name: string, type: 'text' | 'voice' | 'category', topic?: string) => Promise<{ id: string; name: string }>;
  editChannel?: (channelId: string, options: { name?: string; topic?: string }) => Promise<void>;
  getMembers?: () => Promise<{ id: string; username: string; displayName: string; bot: boolean }[]>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
}

/**
 * Resolve a container-relative path to a host path.
 * Only allows paths under the group's workspace to prevent path traversal.
 */
function resolveContainerPath(
  containerPath: string,
  groupIpcDir: string,
): string | null {
  // Container paths like /workspace/ipc/input/file.png → groupIpcDir/input/file.png
  // Container paths like /workspace/group/file.png → groups/{folder}/file.png
  if (containerPath.startsWith('/workspace/ipc/')) {
    const relative = containerPath.replace('/workspace/ipc/', '');
    const resolved = path.resolve(groupIpcDir, relative);
    // Prevent path traversal
    if (!resolved.startsWith(groupIpcDir)) return null;
    return resolved;
  }
  // For /workspace/group/ paths, resolve via groups directory
  if (containerPath.startsWith('/workspace/group/')) {
    const relative = containerPath.replace('/workspace/group/', '');
    // The group folder name is the last segment of groupIpcDir
    const groupFolder = path.basename(groupIpcDir);
    const groupsDir = path.join(DATA_DIR, '..', 'groups');
    const resolved = path.resolve(groupsDir, groupFolder, relative);
    if (!resolved.startsWith(path.resolve(groupsDir, groupFolder))) return null;
    return resolved;
  }
  return null;
}

let ipcWatcherRunning = false;
let selfBuildInProgress = false;
let builderProcess: ChildProcess | null = null;

/**
 * Check if a self-build session is currently active.
 */
export function isSelfBuildActive(): boolean {
  return selfBuildInProgress;
}

/**
 * Send a message to the active Builder sidecar session.
 * Note: stdin is closed after spawn, so direct writing is not possible.
 * Follow-up messages should use --resume with a new claude process.
 * Returns false for now (stdin forwarding not supported in -p mode).
 */
export function sendToBuilder(_text: string): boolean {
  // stdin is ended at spawn time to unblock claude, so we can't write to it.
  // Future: implement follow-ups via `claude --resume <session_id> -p <message>`
  return false;
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  // Clear stale self_build_status from a previous process crash
  try {
    const statusGlob = fs.readdirSync(ipcBaseDir).filter((f) => {
      try {
        return fs.statSync(path.join(ipcBaseDir, f)).isDirectory();
      } catch {
        return false;
      }
    });
    for (const folder of statusGlob) {
      const statusFile = path.join(
        ipcBaseDir,
        folder,
        'self_build_status.json',
      );
      if (fs.existsSync(statusFile)) {
        try {
          const status = JSON.parse(fs.readFileSync(statusFile, 'utf-8'));
          if (status.active) {
            logger.warn(
              { folder },
              'Clearing stale self_build_status from previous run',
            );
            fs.writeFileSync(
              statusFile,
              JSON.stringify(
                {
                  ...status,
                  active: false,
                  status: 'interrupted',
                  detail: 'Service restarted while build was active',
                },
                null,
                2,
              ),
            );
          }
        } catch {
          /* ignore corrupt file */
        }
      }
    }
  } catch {
    /* ignore */
  }

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Authorization: verify this group can send to this chatJid
              const targetGroup = registeredGroups[data.chatJid];
              const authorized =
                isMain || (targetGroup && targetGroup.folder === sourceGroup);

              if (data.chatJid && authorized) {
                if (data.type === 'message' && data.text) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else if (
                  data.type === 'attachment' &&
                  data.filePath &&
                  deps.sendAttachment
                ) {
                  // Resolve container path to host path via group's IPC directory
                  const groupIpcDir = path.join(ipcBaseDir, sourceGroup);
                  const hostPath = resolveContainerPath(
                    data.filePath,
                    groupIpcDir,
                  );
                  if (hostPath && fs.existsSync(hostPath)) {
                    await deps.sendAttachment(
                      data.chatJid,
                      hostPath,
                      data.caption,
                    );
                    logger.info(
                      { chatJid: data.chatJid, sourceGroup, file: hostPath },
                      'IPC attachment sent',
                    );
                  } else {
                    logger.warn(
                      { chatJid: data.chatJid, filePath: data.filePath },
                      'IPC attachment file not found or path outside workspace',
                    );
                  }
                } else if (
                  data.type === 'embed' &&
                  data.embed &&
                  deps.sendEmbed
                ) {
                  await deps.sendEmbed(data.chatJid, data.embed);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC embed sent',
                  );
                } else if (
                  data.type === 'reaction' &&
                  data.messageId &&
                  data.emoji &&
                  deps.addReaction
                ) {
                  await deps.addReaction(
                    data.chatJid,
                    data.messageId,
                    data.emoji,
                  );
                  logger.info(
                    {
                      chatJid: data.chatJid,
                      sourceGroup,
                      messageId: data.messageId,
                    },
                    'IPC reaction added',
                  );
                }
              }
              // Discord admin operations (main group only)
              if (isMain) {
                if (data.type === 'discord_delete_message' && data.channelId && data.messageId && deps.deleteMessage) {
                  await deps.deleteMessage(data.channelId, data.messageId);
                  logger.info({ channelId: data.channelId, messageId: data.messageId, sourceGroup }, 'IPC discord message deleted');
                } else if (data.type === 'discord_delete_messages' && data.channelId && data.count && deps.deleteMessages) {
                  const deleted = await deps.deleteMessages(data.channelId, data.count);
                  logger.info({ channelId: data.channelId, requested: data.count, deleted, sourceGroup }, 'IPC discord bulk delete');
                  // Write result back for the agent to read
                  const resultFile = path.join(ipcBaseDir, sourceGroup, 'admin_result.json');
                  fs.writeFileSync(resultFile, JSON.stringify({ type: 'discord_delete_messages_result', deleted }));
                } else if (data.type === 'discord_create_channel' && data.channelName && deps.createChannel) {
                  const result = await deps.createChannel(data.channelName, data.channelType || 'text', data.topic);
                  logger.info({ ...result, sourceGroup }, 'IPC discord channel created');
                  const resultFile = path.join(ipcBaseDir, sourceGroup, 'admin_result.json');
                  fs.writeFileSync(resultFile, JSON.stringify({ type: 'discord_create_channel_result', ...result }));
                } else if (data.type === 'discord_edit_channel' && data.channelId && deps.editChannel) {
                  await deps.editChannel(data.channelId, { name: data.channelName, topic: data.topic });
                  logger.info({ channelId: data.channelId, sourceGroup }, 'IPC discord channel edited');
                } else if (data.type === 'discord_get_members' && deps.getMembers) {
                  const members = await deps.getMembers();
                  logger.info({ count: members.length, sourceGroup }, 'IPC discord members fetched');
                  const resultFile = path.join(ipcBaseDir, sourceGroup, 'admin_result.json');
                  fs.writeFileSync(resultFile, JSON.stringify({ type: 'discord_get_members_result', members }));
                }
              } else if (!data.chatJid || !authorized) {
                if (data.chatJid && !authorized) {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup, type: data.type },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'change_model': {
      // Main-group-only: update CLAUDE_MODEL in .env
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized change_model attempt blocked',
        );
        break;
      }

      const model = (data as { model?: string }).model;
      if (!model) {
        logger.warn('change_model: no model specified');
        break;
      }

      try {
        const envPath = path.join(process.cwd(), '.env');
        let envContent = fs.readFileSync(envPath, 'utf-8');

        if (envContent.match(/^CLAUDE_MODEL=.*/m)) {
          envContent = envContent.replace(
            /^CLAUDE_MODEL=.*/m,
            `CLAUDE_MODEL=${model}`,
          );
        } else {
          envContent = envContent.trimEnd() + `\nCLAUDE_MODEL=${model}\n`;
        }

        fs.writeFileSync(envPath, envContent);
        logger.info({ model }, 'Model changed in .env');

        if (data.chatJid) {
          await deps.sendMessage(
            data.chatJid,
            `Model changed to **${model}**. Takes effect on next invocation.`,
          );
        }
      } catch (err) {
        logger.error({ err }, 'Failed to change model in .env');
        if (data.chatJid) {
          await deps.sendMessage(
            data.chatJid,
            `Failed to change model: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      break;
    }

    case 'run_claude_session': {
      // Main-group-only: spawn interactive Claude Code sidecar on the host
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized run_claude_session attempt blocked',
        );
        break;
      }

      if (selfBuildInProgress) {
        if (data.chatJid) {
          await deps.sendMessage(
            data.chatJid,
            'Already working on something! Talk to me or wait for me to finish.',
          );
        }
        break;
      }

      const buildPrompt = data.prompt;
      if (!buildPrompt) {
        logger.warn('run_claude_session: no prompt provided');
        break;
      }

      selfBuildInProgress = true;
      const buildChatJid = data.chatJid;
      const buildModel = (data as { model?: string }).model;
      const timeoutMs = Math.min(
        (data as { timeout?: number }).timeout || 600_000,
        1_800_000, // 30 min max
      );
      const cwd = process.cwd();

      const ipcDir = path.join(DATA_DIR, 'ipc', sourceGroup);
      const statusFile = path.join(ipcDir, 'self_build_status.json');
      const logFile = path.join(ipcDir, 'self_build_log.txt');
      const buildStartTime = new Date().toISOString();

      // Append to live build log (readable by container agent)
      const appendLog = (msg: string) => {
        try {
          const ts = new Date().toISOString().slice(11, 19);
          fs.appendFileSync(logFile, `[${ts}] ${msg}\n`);
        } catch {
          /* ignore */
        }
      };

      const writeStatus = (status: string, detail?: string) => {
        try {
          fs.writeFileSync(
            statusFile,
            JSON.stringify(
              {
                active: status === 'running',
                status,
                startedAt: buildStartTime,
                updatedAt: new Date().toISOString(),
                prompt: buildPrompt?.slice(0, 100),
                detail,
              },
              null,
              2,
            ),
          );
        } catch {
          /* ignore */
        }
      };

      // Clear old log and start fresh
      try {
        fs.writeFileSync(logFile, '');
      } catch {
        /* ignore */
      }
      writeStatus('running');

      // Run the entire self-build flow asynchronously using a git worktree
      // so the live service on main is never touched.
      (async () => {
        let branchName = '';
        let worktreeDir = '';
        let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

        // Connect the Mini-Daemon builder bot so messages appear under its own identity.
        // Falls back to the main Daemon bot if the token isn't configured.
        const isDiscord = buildChatJid?.startsWith('dc:') ?? false;
        logger.info(
          { buildChatJid, isDiscord },
          'Self-build: checking builder bot eligibility',
        );
        const useBuilderBot = isDiscord && (await connectBuilderBot());
        logger.info(
          { useBuilderBot, buildChatJid },
          'Self-build: builder bot decision',
        );

        const sendAs = async (msg: string) => {
          appendLog(msg);
          if (buildChatJid) {
            try {
              const formatted = msg;
              if (useBuilderBot) {
                await builderSendMessage(buildChatJid, formatted);
              } else {
                await deps.sendMessage(buildChatJid, formatted);
              }
            } catch (err) {
              logger.warn(
                { err, chatJid: buildChatJid },
                'Mini-Daemon: failed to send message to Discord',
              );
            }
          }
        };

        // Cleanup helper — removes worktree + branch, never touches cwd/main
        const cleanup = () => {
          if (useBuilderBot) disconnectBuilderBot();
          try {
            if (worktreeDir && fs.existsSync(worktreeDir)) {
              execSync(`git worktree remove --force ${worktreeDir}`, { cwd });
            }
          } catch (wtErr) {
            logger.warn(
              { err: wtErr, worktreeDir },
              'Mini-Daemon: worktree remove failed',
            );
            // Force-remove the directory if git worktree remove failed
            try {
              fs.rmSync(worktreeDir, { recursive: true, force: true });
              execSync('git worktree prune', { cwd });
            } catch {
              /* last resort */
            }
          }
          try {
            if (branchName) {
              execSync(`git branch -D ${branchName}`, { cwd, stdio: 'pipe' });
            }
          } catch {
            /* branch may not exist */
          }

          if (heartbeatInterval) clearInterval(heartbeatInterval);
        };

        try {
          await sendAs("I'm spinning up! Setting up an isolated worktree...");

          // Create worktree — isolated copy, main stays untouched
          const hash = execSync('git rev-parse --short HEAD', { cwd })
            .toString()
            .trim();
          branchName = `self-build/${hash}-${Date.now()}`;
          worktreeDir = path.join(os.tmpdir(), `nanoclaw-build-${Date.now()}`);

          execSync(`git worktree add -b ${branchName} ${worktreeDir} HEAD`, {
            cwd,
          });

          await sendAs(
            `Worktree created at \`${worktreeDir}\` on branch \`${branchName}\`. Main is untouched. Starting work!`,
          );

          // Verify claude binary exists
          try {
            execSync('which claude', { cwd, stdio: 'pipe' });
          } catch {
            await sendAs(
              'Failed to start — `claude` CLI not found on PATH. Is Claude Code installed?',
            );
            cleanup();
            selfBuildInProgress = false;
            writeStatus('failed', 'claude CLI not found');
            return;
          }

          // Prepend relay instructions so Mini-Daemon doesn't try to find MCP tools for Discord
          const fullPrompt = [
            '## CRITICAL: How your output reaches the user',
            '',
            'You are Mini-Daemon, a builder sidecar. Your stdout is parsed by the host process and automatically relayed to Discord.',
            'Every text block you produce is sent as a Discord message — you do NOT need any MCP tools, ToolSearch, or send_message calls.',
            'There are NO messaging tools available in this session. Do not search for them or mention their absence.',
            'Just write your responses normally and they will appear in Discord.',
            '',
            '---',
            '',
            buildPrompt,
          ].join('\n');

          // Spawn Claude Code in the worktree directory (not cwd!)
          const claudeArgs = [
            '-p',
            fullPrompt,
            '--output-format',
            'stream-json',
            '--dangerously-skip-permissions',
            '--verbose',
          ];
          if (buildModel) {
            claudeArgs.push('--model', buildModel);
          }
          // Strip CLAUDECODE to prevent "nested session" rejection.
          // Merge Discord env vars from .env file since readEnvFile()
          // deliberately does not populate process.env.
          const discordEnv = readEnvFile([
            'DISCORD_BUILDER_BOT_TOKEN',
            'DISCORD_BOT_TOKEN',
          ]);
          const spawnEnv = { ...process.env, ...discordEnv };
          delete spawnEnv.CLAUDECODE;
          const claude = spawn('claude', claudeArgs, {
            cwd: worktreeDir,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: spawnEnv,
          });

          builderProcess = claude;

          // Close stdin so Claude Code proceeds with the -p prompt
          // instead of blocking for interactive input.
          // Follow-up messages use --resume in a new process.
          claude.stdin.end();

          if (!claude.pid) {
            await sendAs('Failed to spawn `claude` process — no PID assigned.');
            cleanup();
            selfBuildInProgress = false;
            builderProcess = null;
            writeStatus('failed', 'spawn failed - no PID');
            return;
          }

          await sendAs(`Builder started (PID ${claude.pid}).`);

          // Mini-Daemon output filtering: only relay meaningful text to Discord.
          // Tool calls are logged but NOT sent to Discord to avoid spam.
          // Only text blocks and the final result are relayed.
          let textBuffer = '';
          let flushTimer: ReturnType<typeof setTimeout> | null = null;
          const FLUSH_DELAY = 5000;

          const flushBuffers = async () => {
            flushTimer = null;
            if (textBuffer.trim()) {
              const msg =
                textBuffer.length > 1500
                  ? textBuffer.slice(0, 1500) + '...'
                  : textBuffer;
              textBuffer = '';
              await sendAs(msg);
            }
          };

          const scheduleFlush = () => {
            if (flushTimer) clearTimeout(flushTimer);
            flushTimer = setTimeout(flushBuffers, FLUSH_DELAY);
          };

          let lastOutputTime = Date.now();

          // Parse streaming JSON output
          let stdoutLineBuffer = '';
          claude.stdout.on('data', (chunk: Buffer) => {
            stdoutLineBuffer += chunk.toString();
            const lines = stdoutLineBuffer.split('\n');
            stdoutLineBuffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const event = JSON.parse(line);
                lastOutputTime = Date.now();

                if (event.type === 'assistant' && event.message?.content) {
                  for (const block of event.message.content) {
                    if (block.type === 'text' && block.text) {
                      textBuffer += block.text;
                      scheduleFlush();
                    }
                    // Tool calls are intentionally NOT relayed to Discord.
                    // They are still logged via appendLog in sendAs for debugging.
                    if (block.type === 'tool_use') {
                      const toolName = block.name || 'tool';
                      logger.debug(
                        { builder: true, tool: toolName },
                        'Builder tool call (not relayed)',
                      );
                    }
                  }
                }

                if (event.type === 'result') {
                  if (flushTimer) clearTimeout(flushTimer);
                  flushBuffers()
                    .then(() => {
                      const rt = event.result || '';
                      if (rt.length > 0) {
                        const t =
                          rt.length > 1500 ? rt.slice(0, 1500) + '...' : rt;
                        sendAs(t).catch(() => {});
                      }
                    })
                    .catch(() => {});
                }
              } catch {
                /* not JSON */
              }
            }
          });

          // Log stderr but don't relay to Discord (reduces spam).
          // Errors are captured in the final result or build-fail embed.
          claude.stderr.on('data', (chunk: Buffer) => {
            const text = chunk.toString().trim();
            logger.debug({ builder: true }, text);
            lastOutputTime = Date.now();
            appendLog(`stderr: ${text}`);
          });

          // Heartbeat (max 5)
          let heartbeatCount = 0;
          heartbeatInterval = setInterval(async () => {
            if (heartbeatCount >= 5) {
              if (heartbeatInterval) clearInterval(heartbeatInterval);
              return;
            }
            const silentMs = Date.now() - lastOutputTime;
            if (silentMs > 30_000) {
              heartbeatCount++;
              await sendAs(
                'Still working... (no output for ' +
                  Math.round(silentMs / 1000) +
                  's)',
              );
              lastOutputTime = Date.now();
            }
          }, 30_000);

          // Wait for claude to exit
          const exitCode = await new Promise<number | null>((resolve) => {
            const killTimer = setTimeout(async () => {
              logger.warn('Builder timeout, killing');
              await sendAs(
                `⏰ Timeout reached (${Math.round(timeoutMs / 60_000)} min). Stopping builder...`,
              );
              claude.kill('SIGTERM');
              setTimeout(() => claude.kill('SIGKILL'), 10_000);
            }, timeoutMs);

            claude.on('close', (code) => {
              clearTimeout(killTimer);
              resolve(code);
            });
            claude.on('error', (spawnErr) => {
              clearTimeout(killTimer);
              logger.error({ err: spawnErr }, 'Builder spawn error');
              resolve(1);
            });
          });

          if (heartbeatInterval) clearInterval(heartbeatInterval);

          builderProcess = null;
          if (flushTimer) {
            clearTimeout(flushTimer);
            await flushBuffers();
          }

          if (exitCode !== 0) {
            throw new Error(`Claude exited with code ${exitCode}`);
          }

          await sendAs('Session complete! Validating build in worktree...');

          // Commit any uncommitted changes in the worktree
          try {
            execSync('git add -A', { cwd: worktreeDir });
            try {
              execSync('git diff --cached --quiet', { cwd: worktreeDir });
            } catch {
              const { execFileSync } = await import('child_process');
              const commitMsg = `self-build: ${buildPrompt.slice(0, 80).replace(/[^\w\s\-.,!?()]/g, '')}`;
              execFileSync('git', ['commit', '-m', commitMsg], {
                cwd: worktreeDir,
              });
            }
          } catch {
            // No changes to commit is fine
          }

          // Validate: build + test (in the worktree, not main)
          try {
            execSync('npm install 2>/dev/null; npm run build && npm test', {
              cwd: worktreeDir,
              timeout: 180_000,
              stdio: 'pipe',
            });
          } catch (validateErr) {
            const errMsg =
              validateErr instanceof Error
                ? validateErr.message.slice(-500)
                : String(validateErr);
            const failEmbed: EmbedData = {
              title: '🔧 Build Failed',
              description:
                'Build/test validation failed in worktree. No changes made to main.',
              color: 16711680,
              fields: [
                {
                  name: 'Error',
                  value: '```\n' + errMsg.slice(0, 900) + '\n```',
                  inline: false,
                },
              ],
            };
            if (buildChatJid && useBuilderBot) {
              await builderSendEmbed(buildChatJid, failEmbed);
            } else if (buildChatJid && deps.sendEmbed) {
              await deps.sendEmbed(buildChatJid, failEmbed);
            } else {
              await sendAs(
                `Build/test failed in worktree — main is untouched.\n\`\`\`\n${errMsg}\n\`\`\``,
              );
            }
            cleanup();
            writeStatus('failed', errMsg);
            selfBuildInProgress = false;
            return;
          }

          // Success — merge worktree branch into main
          await sendAs('Build + tests passed! Merging into main...');

          // Auto-commit any uncommitted changes on main so git merge doesn't fail.
          // This is safer than stash — stash pop can produce conflict markers.
          let didAutoCommit = false;
          try {
            execSync('git add -A', { cwd, stdio: 'pipe' });
            try {
              execSync('git diff --cached --quiet', { cwd, stdio: 'pipe' });
            } catch {
              // There are staged changes — commit them
              execSync(
                'git commit -m "wip: auto-save before self-build merge"',
                { cwd, stdio: 'pipe' },
              );
              didAutoCommit = true;
            }
          } catch {
            /* nothing to commit */
          }

          // Determine which files changed BEFORE merging (for smart reload)
          const preMergeHead = execSync('git rev-parse HEAD', {
            cwd,
            encoding: 'utf-8',
          }).trim();

          execSync(`git merge ${branchName} --no-edit`, { cwd });

          // Get list of changed files between pre-merge HEAD and current HEAD
          const changedFiles = execSync(
            `git diff --name-only ${preMergeHead} HEAD`,
            { cwd, encoding: 'utf-8' },
          )
            .trim()
            .split('\n')
            .filter(Boolean);

          // Determine if a full service restart is needed based on changed files.
          // Hot-reloadable: workspace files (groups/), container agent source,
          // docs, CLAUDE.md, .claude/ skills, config files read at runtime.
          // Restart-required: compiled src/, package.json deps, Dockerfile.
          const needsRestart = changedFiles.some((f) => {
            // Compiled host source code — requires restart
            if (f.startsWith('src/')) return true;
            // Dependency changes
            if (f === 'package.json' || f === 'package-lock.json') return true;
            // Container image changes (need rebuild + restart)
            if (f === 'container/Dockerfile' || f === 'container/build.sh')
              return true;
            // tsconfig changes affect compiled output
            if (f === 'tsconfig.json') return true;
            return false;
          });

          // Clean up the worktree AFTER determining changed files but BEFORE
          // sending the result embed. Don't disconnect builder bot yet — we
          // need it for the embed.
          try {
            if (worktreeDir && fs.existsSync(worktreeDir)) {
              execSync(`git worktree remove --force ${worktreeDir}`, { cwd });
            }
          } catch (wtErr) {
            logger.warn(
              { err: wtErr, worktreeDir },
              'Mini-Daemon: worktree remove failed',
            );
            try {
              fs.rmSync(worktreeDir, { recursive: true, force: true });
              execSync('git worktree prune', { cwd });
            } catch {
              /* last resort */
            }
          }
          try {
            if (branchName) {
              execSync(`git branch -D ${branchName}`, { cwd, stdio: 'pipe' });
            }
          } catch {
            /* branch may not exist */
          }

          if (heartbeatInterval) clearInterval(heartbeatInterval);

          const reloadAction = needsRestart
            ? 'Restarting now...'
            : 'No restart needed — changes are hot-reloadable.';
          const successEmbed: EmbedData = {
            title: '🔧 Build Complete',
            description: `Changes merged from worktree branch \`${branchName}\`. Build and tests passed.`,
            color: 65280,
            fields: [
              {
                name: 'Prompt',
                value: buildPrompt.slice(0, 200),
                inline: false,
              },
              {
                name: 'Changed Files',
                value:
                  changedFiles.length <= 10
                    ? changedFiles.map((f) => `\`${f}\``).join('\n')
                    : `${changedFiles.length} files changed`,
                inline: false,
              },
              {
                name: 'Action',
                value: reloadAction,
                inline: false,
              },
            ],
            footer: needsRestart ? 'Restarting now...' : 'Hot-reload complete',
          };
          if (buildChatJid && useBuilderBot) {
            await builderSendEmbed(buildChatJid, successEmbed);
          } else if (buildChatJid && deps.sendEmbed) {
            await deps.sendEmbed(buildChatJid, successEmbed);
          } else {
            await sendAs(
              `All done! Changes merged from \`${branchName}\`, build + tests passed. ${reloadAction}`,
            );
          }

          // NOW disconnect the builder bot (after embed is sent)
          if (useBuilderBot) disconnectBuilderBot();

          writeStatus(
            'completed',
            needsRestart ? 'merged+restarting' : 'merged+hot-reload',
          );
          selfBuildInProgress = false;
          builderProcess = null;

          if (needsRestart) {
            exec('systemctl --user restart nanoclaw', { timeout: 15_000 });
          } else {
            logger.info(
              { changedFiles },
              'Self-build: hot-reload — no restart needed',
            );
          }
        } catch (err) {
          const errMsg =
            err instanceof Error ? err.message.slice(-500) : String(err);
          // Send error embed BEFORE disconnecting the builder bot
          const errEmbed: EmbedData = {
            title: '🔧 Error',
            description:
              'Something went wrong. Worktree cleaned up, main is untouched.',
            color: 16711680,
            fields: [
              {
                name: 'Error',
                value: '```\n' + errMsg.slice(0, 900) + '\n```',
                inline: false,
              },
            ],
          };
          if (buildChatJid && useBuilderBot) {
            await builderSendEmbed(buildChatJid, errEmbed);
          } else if (buildChatJid && deps.sendEmbed) {
            await deps.sendEmbed(buildChatJid, errEmbed);
          } else {
            await sendAs(
              `Something went wrong — worktree cleaned up, main untouched.\n\`\`\`\n${errMsg}\n\`\`\``,
            );
          }
          // NOW clean up (disconnects builder bot)
          cleanup();
          writeStatus('failed', errMsg);
          selfBuildInProgress = false;
          builderProcess = null;
        }
      })();

      break;
    }

    case 'forward_to_builder': {
      if (!isMain) break;
      const msg = (data as { message?: string }).message;
      if (msg) {
        const sent = sendToBuilder(msg);
        logger.info({ sent, sourceGroup }, 'forward_to_builder via IPC');
        if (!sent && data.chatJid) {
          await deps.sendMessage(
            data.chatJid,
            'No active Mini-Daemon session to forward to.',
          );
        }
      }
      break;
    }

    case 'cancel_build': {
      if (!isMain) break;
      if (!selfBuildInProgress || !builderProcess) {
        if (data.chatJid) {
          await deps.sendMessage(
            data.chatJid,
            'No active Mini-Daemon session to cancel.',
          );
        }
        break;
      }
      logger.info({ sourceGroup }, 'Cancelling Mini-Daemon build via IPC');
      if (data.chatJid) {
        await deps.sendMessage(data.chatJid, 'Cancelling Mini-Daemon build...');
      }
      builderProcess.kill('SIGTERM');
      setTimeout(() => {
        if (builderProcess) builderProcess.kill('SIGKILL');
      }, 10_000);
      break;
    }

    case 'run_host_command': {
      // Main-group-only: run a predefined host command (e.g., update, restart)
      if (!isMain) {
        logger.warn(
          { sourceGroup, command: data.prompt },
          'Unauthorized run_host_command attempt blocked',
        );
        break;
      }

      const command = data.prompt; // Reuse prompt field for the command name
      const allowedCommands: Record<string, string> = {
        update: `cd "${process.cwd()}" && git stash --include-untracked 2>/dev/null; git pull origin main && npm install && npm run build && git stash pop 2>/dev/null; true`,
        restart: `systemctl --user restart nanoclaw`,
        status: `cd "${process.cwd()}" && git log --oneline -5 && echo "---" && systemctl --user status nanoclaw --no-pager`,
      };

      const cmd = allowedCommands[command || ''];
      if (!cmd) {
        logger.warn(
          { command },
          'Unknown host command — allowed: update, restart, status',
        );
        // Send feedback to the user
        if (data.chatJid) {
          await deps.sendMessage(
            data.chatJid,
            `Unknown command "${command}". Allowed: ${Object.keys(allowedCommands).join(', ')}`,
          );
        }
        break;
      }

      logger.info({ command, sourceGroup }, 'Executing host command via IPC');

      exec(cmd, { timeout: 120_000 }, async (err, stdout, stderr) => {
        const output = stdout || stderr || (err ? err.message : 'Done');
        const truncated =
          output.length > 1500 ? output.slice(-1500) + '...' : output;
        if (data.chatJid) {
          await deps.sendMessage(
            data.chatJid,
            `**Host command: ${command}**\n\`\`\`\n${truncated}\n\`\`\``,
          );
        }
        if (err) {
          logger.error({ command, err: err.message }, 'Host command failed');
        } else {
          logger.info({ command }, 'Host command completed');
        }
      });
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
