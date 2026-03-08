import { ChildProcess, exec, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { EmbedData, RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendAttachment?: (jid: string, filePath: string, caption?: string) => Promise<void>;
  sendEmbed?: (jid: string, embed: EmbedData) => Promise<void>;
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
 * Returns true if message was delivered, false if no active session.
 */
export function sendToBuilder(text: string): boolean {
  if (!selfBuildInProgress || !builderProcess?.stdin?.writable) return false;
  try {
    builderProcess.stdin.write(text + '\n');
    return true;
  } catch {
    return false;
  }
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

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
                isMain ||
                (targetGroup && targetGroup.folder === sourceGroup);

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
                }
              } else if (data.chatJid && !authorized) {
                logger.warn(
                  { chatJid: data.chatJid, sourceGroup, type: data.type },
                  'Unauthorized IPC message attempt blocked',
                );
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
            '🔧 **Mini-Daemon**: Already working on something! Talk to me or wait for me to finish.',
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
      const timeoutMs = Math.min(
        (data as { timeout?: number }).timeout || 600_000,
        1_800_000, // 30 min max
      );
      const cwd = process.cwd();

      const sendAs = async (msg: string) => {
        if (buildChatJid) {
          await deps.sendMessage(buildChatJid, `🔧 **Mini-Daemon**: ${msg}`);
        }
      };

      // Run the entire self-build flow asynchronously
      (async () => {
        let originalBranch = '';
        let branchName = '';
        let didStash = false;

        try {
          await sendAs("I'm spinning up! Give me a sec to set up safety rails...");

          // Git safety net
          originalBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd })
            .toString()
            .trim();
          const stashBefore = execSync('git stash list', { cwd })
            .toString()
            .trim()
            .split('\n')
            .filter(Boolean).length;
          execSync('git stash --include-untracked', { cwd });
          const stashAfter = execSync('git stash list', { cwd })
            .toString()
            .trim()
            .split('\n')
            .filter(Boolean).length;
          didStash = stashAfter > stashBefore;

          const hash = execSync('git rev-parse --short HEAD', { cwd })
            .toString()
            .trim();
          branchName = `self-build/${hash}-${Date.now()}`;
          execSync(`git checkout -b ${branchName}`, { cwd });

          await sendAs(
            `Safety branch \`${branchName}\` created. Starting work now — talk to me anytime!`,
          );

          // Spawn Claude Code as interactive sidecar with streaming output
          const claude = spawn('claude', [
            '--output-format', 'stream-json',
            '--dangerously-skip-permissions',
            '--verbose',
          ], {
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env },
          });

          builderProcess = claude;

          // Write the initial prompt
          claude.stdin.write(buildPrompt + '\n');

          // Batched progress updates — avoids spamming Discord
          // Accumulates text + tool calls and flushes as a single message
          let textBuffer = '';
          let toolBuffer: string[] = [];
          let flushTimer: ReturnType<typeof setTimeout> | null = null;
          const FLUSH_DELAY = 5000; // batch for 5s before sending

          const flushBuffers = async () => {
            flushTimer = null;
            const parts: string[] = [];

            if (toolBuffer.length > 0) {
              // Compact tool summary — collapse consecutive reads/globs into one line
              const summary = toolBuffer.join(', ');
              parts.push(`⚙️ ${summary}`);
              toolBuffer = [];
            }

            if (textBuffer.trim()) {
              const msg = textBuffer.length > 1500
                ? textBuffer.slice(0, 1500) + '...'
                : textBuffer;
              parts.push(msg);
              textBuffer = '';
            }

            if (parts.length > 0) {
              await sendAs(parts.join('\n'));
            }
          };

          const scheduleFlush = () => {
            if (flushTimer) clearTimeout(flushTimer);
            flushTimer = setTimeout(flushBuffers, FLUSH_DELAY);
          };

          // Parse streaming JSON output from claude
          let stdoutLineBuffer = '';
          claude.stdout.on('data', (chunk: Buffer) => {
            stdoutLineBuffer += chunk.toString();
            const lines = stdoutLineBuffer.split('\n');
            stdoutLineBuffer = lines.pop() || ''; // keep incomplete last line

            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const event = JSON.parse(line);

                // Relay assistant text to Discord (batched)
                if (event.type === 'assistant' && event.message?.content) {
                  for (const block of event.message.content) {
                    if (block.type === 'text' && block.text) {
                      textBuffer += block.text;
                      scheduleFlush();
                    }
                    // Collect tool usage compactly
                    if (block.type === 'tool_use') {
                      const toolName = block.name || 'tool';
                      const input = block.input || {};
                      let detail = '';
                      if (input.file_path) {
                        // Show just filename, not full path
                        const basename = input.file_path.split('/').pop();
                        detail = `(${basename})`;
                      } else if (toolName === 'Bash' && input.command) {
                        detail = `(\`${input.command.slice(0, 40)}\`)`;
                      } else if (input.pattern) {
                        detail = `(${input.pattern})`;
                      }
                      toolBuffer.push(`${toolName}${detail}`);
                      scheduleFlush();
                    }
                  }
                }

                // Final result — flush everything and send
                if (event.type === 'result') {
                  if (flushTimer) clearTimeout(flushTimer);
                  flushBuffers();
                  const resultText = event.result || '';
                  if (resultText && resultText.length > 0) {
                    const truncated = resultText.length > 1500
                      ? resultText.slice(0, 1500) + '...'
                      : resultText;
                    sendAs(truncated);
                  }
                }
              } catch {
                // Not JSON or parse error — ignore
              }
            }
          });

          claude.stderr.on('data', (chunk: Buffer) => {
            logger.debug({ builder: true }, chunk.toString().trim());
          });

          // Wait for claude to exit
          const exitCode = await new Promise<number | null>((resolve) => {
            const killTimer = setTimeout(() => {
              logger.warn('Builder timeout, killing');
              claude.kill('SIGTERM');
              setTimeout(() => claude.kill('SIGKILL'), 10_000);
            }, timeoutMs);

            claude.on('close', (code) => {
              clearTimeout(killTimer);
              resolve(code);
            });
            claude.on('error', (err) => {
              clearTimeout(killTimer);
              logger.error({ err }, 'Builder spawn error');
              resolve(1);
            });
          });

          builderProcess = null;
          if (flushTimer) {
            clearTimeout(flushTimer);
            await flushBuffers();
          }

          if (exitCode !== 0) {
            throw new Error(`Claude exited with code ${exitCode}`);
          }

          await sendAs('Session complete! Validating build...');

          // Commit any uncommitted changes
          try {
            execSync('git add -A', { cwd });
            execSync(
              `git diff --cached --quiet || git commit -m "self-build: ${buildPrompt.slice(0, 50).replace(/"/g, "'")}"`,
              { cwd },
            );
          } catch {
            // No changes to commit is fine
          }

          // Validate: build + test
          try {
            execSync('npm run build && npm test', {
              cwd,
              timeout: 120_000,
              stdio: 'pipe',
            });
          } catch (validateErr) {
            const errMsg =
              validateErr instanceof Error
                ? validateErr.message.slice(-500)
                : String(validateErr);
            execSync(`git checkout ${originalBranch}`, { cwd });
            execSync(`git branch -D ${branchName}`, { cwd });
            if (didStash) {
              try { execSync('git stash pop', { cwd }); } catch { /* */ }
            }
            await sendAs(
              `Build/test failed — rolled back.\n\`\`\`\n${errMsg}\n\`\`\``,
            );
            selfBuildInProgress = false;
            return;
          }

          // Success — merge into original branch
          execSync(`git checkout ${originalBranch}`, { cwd });
          execSync(`git merge ${branchName} --no-edit`, { cwd });
          if (didStash) {
            try { execSync('git stash pop', { cwd }); } catch { /* */ }
          }

          await sendAs(
            `All done! Changes merged from \`${branchName}\`, build + tests passed. Restarting now...`,
          );

          selfBuildInProgress = false;
          builderProcess = null;
          exec('systemctl --user restart nanoclaw', { timeout: 15_000 });
        } catch (err) {
          const errMsg =
            err instanceof Error ? err.message.slice(-500) : String(err);
          try {
            if (branchName && originalBranch) {
              execSync(`git checkout ${originalBranch}`, { cwd });
              try { execSync(`git branch -D ${branchName}`, { cwd }); } catch { /* */ }
            }
            if (didStash) {
              try { execSync('git stash pop', { cwd }); } catch { /* */ }
            }
          } catch { /* rollback failed */ }
          await sendAs(`Something went wrong — rolled back.\n\`\`\`\n${errMsg}\n\`\`\``);
          selfBuildInProgress = false;
          builderProcess = null;
        }
      })();

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
        update: `cd "${process.cwd()}" && git pull origin main && npm install && npm run build`,
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
