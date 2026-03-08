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
  const fromEnv = process.env.DISCORD_BUILDER_BOT_TOKEN || '';
  const envVars = readEnvFile(['DISCORD_BUILDER_BOT_TOKEN']);
  const fromFile = envVars.DISCORD_BUILDER_BOT_TOKEN || '';

  const token = fromEnv || fromFile;

  logger.info(
    {
      fromProcessEnv: fromEnv ? `${fromEnv.length} chars` : '(empty)',
      fromDotEnv: fromFile ? `${fromFile.length} chars` : '(empty)',
      resolved: token ? `${token.length} chars` : '(empty)',
      cwd: process.cwd(),
    },
    'Builder bot: token resolution',
  );

  return token;
}

/**
 * Connect the Mini-Daemon builder bot. Returns true if connected, false if
 * no token is configured. Reuses an existing connection if already logged in.
 */
export async function connectBuilderBot(): Promise<boolean> {
  logger.info('Builder bot: connectBuilderBot() entered');
  try {
    if (client && ready) {
      logger.info('Builder bot: reusing existing connection');
      return true;
    }

    const token = getToken();
    if (!token) {
      logger.warn(
        'Builder bot: DISCORD_BUILDER_BOT_TOKEN not set — falling back to main bot',
      );
      return false;
    }

    // Tear down stale client if exists
    if (client) {
      try {
        client.destroy();
      } catch {
        /* ignore */
      }
    }

    logger.info('Builder bot: creating Client and calling login...');
    client = new Client({ intents: [GatewayIntentBits.Guilds] });

    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        logger.warn('Builder bot login timed out (15s)');
        resolve(false);
      }, 15_000);

      client!.once('ready', (c) => {
        clearTimeout(timeout);
        ready = true;
        logger.info(
          { username: c.user.tag, id: c.user.id },
          'Builder bot connected as',
        );
        resolve(true);
      });

      client!.login(token).catch((err) => {
        clearTimeout(timeout);
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          'Builder bot login failed',
        );
        resolve(false);
      });
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'Builder bot: connectBuilderBot() threw unexpectedly',
    );
    return false;
  }
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
  if (!channel) {
    logger.warn(
      { jid },
      'Builder bot: cannot resolve channel — message dropped',
    );
    return;
  }

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
