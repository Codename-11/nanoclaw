import fs from 'fs';
import path from 'path';

import {
  AttachmentBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
  ThreadChannel,
} from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  EmbedData,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  getAttachmentDir?: (chatJid: string) => string | null;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  // Track active thread per group JID so replies go to the right thread
  private activeThreads = new Map<string, string>();
  // Typing refresh intervals per JID (Discord typing expires after ~10s)
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMembers,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      const channelId = message.channelId;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Thread support: if message is in a thread, route to the parent channel's
      // registered group but track the thread ID for replies.
      let routingJid: string;
      if (message.channel.isThread()) {
        const parentId = (message.channel as ThreadChannel).parentId;
        routingJid = `dc:${parentId}`;
        this.activeThreads.set(routingJid, channelId);
      } else {
        routingJid = `dc:${channelId}`;
      }

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel.isThread()
          ? (message.channel as ThreadChannel)
          : (message.channel as TextChannel);
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Early registered-group check so we can show typing before slow I/O
      const group = this.opts.registeredGroups()[routingJid];
      if (group) {
        // Show "typing..." instantly before attachment downloads / reply fetches
        try {
          if ('sendTyping' in message.channel) {
            await (message.channel as TextChannel).sendTyping();
          }
        } catch {
          // Non-critical — don't block message processing
        }
      }

      // Handle attachments — download to group workspace if possible, else placeholder
      if (message.attachments.size > 0) {
        const attachDir = this.opts.getAttachmentDir?.(routingJid);
        const attachmentDescriptions: string[] = [];

        for (const att of message.attachments.values()) {
          const contentType = att.contentType || '';
          const safeName = `${Date.now()}-${att.name || 'file'}`;

          if (attachDir) {
            try {
              const response = await fetch(att.url);
              const buffer = Buffer.from(await response.arrayBuffer());
              fs.mkdirSync(attachDir, { recursive: true });
              fs.writeFileSync(path.join(attachDir, safeName), buffer);
              // Container-relative path so agent can access the file
              attachmentDescriptions.push(
                `[Attachment: /workspace/ipc/input/${safeName}]`,
              );
              logger.info(
                { filename: safeName, size: buffer.length },
                'Discord attachment downloaded',
              );
            } catch (err) {
              logger.error(
                { att: att.name, err },
                'Failed to download Discord attachment',
              );
              // Fall back to placeholder
              attachmentDescriptions.push(
                this.attachmentPlaceholder(contentType, att.name),
              );
            }
          } else {
            attachmentDescriptions.push(
              this.attachmentPlaceholder(contentType, att.name),
            );
          }
        }

        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        routingJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      // Only deliver full message for registered groups
      if (!group) {
        logger.debug(
          { chatJid: routingJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // Deliver message
      this.opts.onMessage(routingJid, {
        id: msgId,
        chat_jid: routingJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid: routingJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channel = await this.resolveChannel(jid);
    if (!channel) return;

    // Clear typing indicator BEFORE sending the message.
    // This prevents a race condition where the 7s refresh interval fires
    // a sendTyping() call between message delivery and interval cleanup,
    // causing "typing..." to persist for another ~10s after the response.
    this.clearTypingInterval(jid);

    // Discord has a 2000 character limit per message — split if needed
    const MAX_LENGTH = 2000;
    if (text.length <= MAX_LENGTH) {
      await channel.send(text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await channel.send(text.slice(i, i + MAX_LENGTH));
      }
    }
    logger.info({ jid, length: text.length }, 'Discord message sent');
  }

  async sendAttachment(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    const channel = await this.resolveChannel(jid);
    if (!channel) return;

    try {
      const attachment = new AttachmentBuilder(filePath);
      await channel.send({
        content: caption || undefined,
        files: [attachment],
      });
      logger.info({ jid, filePath }, 'Discord attachment sent');
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Failed to send Discord attachment');
    }
  }

  async sendEmbed(jid: string, embedData: EmbedData): Promise<void> {
    const channel = await this.resolveChannel(jid);
    if (!channel) return;

    try {
      const embed = new EmbedBuilder();
      if (embedData.title) embed.setTitle(embedData.title);
      if (embedData.description) embed.setDescription(embedData.description);
      if (embedData.color != null) embed.setColor(embedData.color);
      if (embedData.url) embed.setURL(embedData.url);
      if (embedData.thumbnail) embed.setThumbnail(embedData.thumbnail);
      if (embedData.image) embed.setImage(embedData.image);
      if (embedData.footer) embed.setFooter({ text: embedData.footer });
      if (embedData.fields) {
        for (const field of embedData.fields) {
          embed.addFields({
            name: field.name,
            value: field.value,
            inline: field.inline,
          });
        }
      }
      await channel.send({ embeds: [embed] });
      logger.info({ jid, title: embedData.title }, 'Discord embed sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord embed');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    // Clear all typing refresh intervals
    for (const jid of this.typingIntervals.keys()) {
      this.clearTypingInterval(jid);
    }

    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  /**
   * Clear the typing refresh interval for a JID without any async operations.
   * Synchronous to avoid race conditions between interval firing and cleanup.
   */
  private clearTypingInterval(jid: string): void {
    const existing = this.typingIntervals.get(jid);
    if (existing) {
      clearInterval(existing);
      this.typingIntervals.delete(jid);
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    // Always clear existing refresh interval first
    this.clearTypingInterval(jid);

    if (!this.client || !isTyping) return;
    try {
      const channel = await this.resolveChannel(jid);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
        // Refresh every 7s to keep "typing..." visible until response arrives
        const interval = setInterval(async () => {
          try {
            await (channel as TextChannel).sendTyping();
          } catch {
            // Non-critical — stop refreshing if channel becomes unavailable
            clearInterval(interval);
            this.typingIntervals.delete(jid);
          }
        }, 7000);
        this.typingIntervals.set(jid, interval);
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }

  // --- Discord Admin API methods ---

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    if (!this.client) throw new Error('Discord client not initialized');
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('messages' in channel)) {
      throw new Error(`Channel ${channelId} not found or not text-based`);
    }
    const textChannel = channel as TextChannel;
    const message = await textChannel.messages.fetch(messageId);
    await message.delete();
    logger.info({ channelId, messageId }, 'Discord message deleted');
  }

  async deleteMessages(channelId: string, count: number): Promise<number> {
    if (!this.client) throw new Error('Discord client not initialized');
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('bulkDelete' in channel)) {
      throw new Error(
        `Channel ${channelId} not found or doesn't support bulk delete`,
      );
    }
    const textChannel = channel as TextChannel;
    const clamped = Math.min(Math.max(1, count), 100);
    const deleted = await textChannel.bulkDelete(clamped, true);
    logger.info(
      { channelId, requested: clamped, deleted: deleted.size },
      'Discord bulk delete',
    );
    return deleted.size;
  }

  async createChannel(
    name: string,
    type: 'text' | 'voice' | 'category',
    topic?: string,
  ): Promise<{ id: string; name: string }> {
    if (!this.client) throw new Error('Discord client not initialized');
    // Use the first guild the bot is in
    const guild = this.client.guilds.cache.first();
    if (!guild) throw new Error('Bot is not in any guild');

    const typeMap = {
      text: ChannelType.GuildText,
      voice: ChannelType.GuildVoice,
      category: ChannelType.GuildCategory,
    } as const;
    const channelType = typeMap[type] ?? ChannelType.GuildText;
    const created = await guild.channels.create({
      name,
      type: channelType,
      topic: channelType === ChannelType.GuildText ? topic : undefined,
    });
    logger.info(
      { id: created.id, name: created.name, type },
      'Discord channel created',
    );
    return { id: created.id, name: created.name };
  }

  async editChannel(
    channelId: string,
    options: { name?: string; topic?: string },
  ): Promise<void> {
    if (!this.client) throw new Error('Discord client not initialized');
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('edit' in channel)) {
      throw new Error(`Channel ${channelId} not found or not editable`);
    }
    await (channel as TextChannel).edit(options);
    logger.info({ channelId, options }, 'Discord channel edited');
  }

  async getMembers(): Promise<
    { id: string; username: string; displayName: string; bot: boolean }[]
  > {
    if (!this.client) throw new Error('Discord client not initialized');
    const guild = this.client.guilds.cache.first();
    if (!guild) throw new Error('Bot is not in any guild');
    const members = await guild.members.fetch();
    return members.map((m) => ({
      id: m.id,
      username: m.user.username,
      displayName: m.displayName,
      bot: m.user.bot,
    }));
  }

  /**
   * Resolve the correct Discord channel to send to.
   * If there's an active thread for this JID, send to the thread instead.
   */
  private async resolveChannel(
    jid: string,
  ): Promise<TextChannel | ThreadChannel | null> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return null;
    }

    try {
      // Check for active thread first
      const threadId = this.activeThreads.get(jid);
      if (threadId) {
        try {
          const thread = await this.client.channels.fetch(threadId);
          if (thread && thread.isThread()) {
            return thread as ThreadChannel;
          }
        } catch {
          // Thread may have been archived/deleted, fall through to parent
          this.activeThreads.delete(jid);
        }
      }

      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return null;
      }
      return channel as TextChannel;
    } catch (err) {
      logger.error({ jid, err }, 'Failed to resolve Discord channel');
      return null;
    }
  }

  private attachmentPlaceholder(
    contentType: string,
    name?: string | null,
  ): string {
    if (contentType.startsWith('image/')) return `[Image: ${name || 'image'}]`;
    if (contentType.startsWith('video/')) return `[Video: ${name || 'video'}]`;
    if (contentType.startsWith('audio/')) return `[Audio: ${name || 'audio'}]`;
    return `[File: ${name || 'file'}]`;
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts);
});
