import {
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  TextChannel,
} from 'discord.js';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { EmbedData } from './types.js';

let client: Client | null = null;
let ready = false;

/**
 * Get the builder bot token from .env (not process.env, to avoid leaking).
 */
function getToken(): string {
  const envVars = readEnvFile(['DISCORD_BUILDER_BOT_TOKEN']);
  return (
    process.env.DISCORD_BUILDER_BOT_TOKEN ||
    envVars.DISCORD_BUILDER_BOT_TOKEN ||
    ''
  );
}

/**
 * Connect the Mini-Daemon builder bot. Returns true if connected, false if
 * no token is configured. Reuses an existing connection if already logged in.
 */
export async function connectBuilderBot(): Promise<boolean> {
  if (client && ready) return true;

  const token = getToken();
  if (!token) return false;

  // Tear down stale client if exists
  if (client) {
    try {
      client.destroy();
    } catch {
      /* ignore */
    }
  }

  client = new Client({ intents: [GatewayIntentBits.Guilds] });

  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      logger.warn('Builder bot login timed out');
      resolve(false);
    }, 15_000);

    client!.once('ready', (c) => {
      clearTimeout(timeout);
      ready = true;
      logger.info(
        { username: c.user.tag, id: c.user.id },
        'Builder bot connected',
      );
      resolve(true);
    });

    client!.login(token).catch((err) => {
      clearTimeout(timeout);
      logger.warn({ err }, 'Builder bot login failed');
      resolve(false);
    });
  });
}

/**
 * Disconnect the builder bot. Safe to call even if not connected.
 */
export function disconnectBuilderBot(): void {
  if (client) {
    try {
      client.destroy();
    } catch {
      /* ignore */
    }
    client = null;
    ready = false;
  }
}

async function resolveChannel(jid: string): Promise<TextChannel | null> {
  if (!client || !ready) return null;
  try {
    const channelId = jid.replace(/^dc:/, '');
    const channel = await client.channels.fetch(channelId);
    if (!channel || !('send' in channel)) return null;
    return channel as TextChannel;
  } catch (err) {
    logger.warn({ jid, err }, 'Builder bot: failed to resolve channel');
    return null;
  }
}

/**
 * Send a text message as Mini-Daemon.
 */
export async function builderSendMessage(
  jid: string,
  text: string,
): Promise<void> {
  const channel = await resolveChannel(jid);
  if (!channel) return;

  const MAX_LENGTH = 2000;
  if (text.length <= MAX_LENGTH) {
    await channel.send(text);
  } else {
    for (let i = 0; i < text.length; i += MAX_LENGTH) {
      await channel.send(text.slice(i, i + MAX_LENGTH));
    }
  }
}

/**
 * Send an embed as Mini-Daemon.
 */
export async function builderSendEmbed(
  jid: string,
  embedData: EmbedData,
): Promise<void> {
  const channel = await resolveChannel(jid);
  if (!channel) return;

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
}
