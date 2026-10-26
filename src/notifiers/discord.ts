import {
  AlertPayload,
  DeliveryResult,
  NotifierPlugin,
  Severity,
} from '../types/index.js';

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title: string;
  description?: string;
  url?: string;
  color: number;
  fields: DiscordEmbedField[];
  footer?: {
    text: string;
    icon_url?: string;
  };
  timestamp?: string;
}

export interface DiscordWebhookPayload {
  username?: string;
  avatar_url?: string;
  embeds: DiscordEmbed[];
}

export interface DiscordNotifierOptions {
  /**
   * Timeout in milliseconds for outgoing Discord HTTP requests (default: 10,000ms).
   */
  timeoutMs?: number;
  /**
   * Custom username displayed for the Discord bot webhook.
   */
  username?: string;
  /**
   * Custom avatar URL displayed for the Discord bot webhook.
   */
  avatarUrl?: string;
  /**
   * Optional custom fetch implementation for testing and mocking.
   */
  fetchFn?: typeof fetch;
}

/**
 * Decimal RGB color codes corresponding to alert severity levels.
 * Discord embed colors require decimal integers:
 * - CRITICAL: Vivid Red (0xE74C3C / 15158332)
 * - HIGH: Vivid Orange (0xE67E22 / 15105570)
 * - MEDIUM: Sun Yellow (0xF1C40F / 15844352)
 * - LOW: Emerald Green (0x2ECC71 / 3066993)
 */
export const SEVERITY_COLORS: Record<Severity, number> = {
  CRITICAL: 15158332, // #E74C3C
  HIGH: 15105570,     // #E67E22
  MEDIUM: 15844352,   // #F1C40F
  LOW: 3066993,       // #2ECC71
};

/**
 * Severity visual indicators / emojis for Discord embed titles.
 */
export const SEVERITY_BADGES: Record<Severity, string> = {
  CRITICAL: '🚨 [CRITICAL]',
  HIGH: '⚠️ [HIGH]',
  MEDIUM: '🟡 [MEDIUM]',
  LOW: '🟢 [LOW]',
};

/**
 * Formats a Discord embed object from an AlertPayload with color-coded severity.
 */
export function buildDiscordEmbed(payload: AlertPayload): DiscordEmbed {
  const color = SEVERITY_COLORS[payload.severity] ?? SEVERITY_COLORS.MEDIUM;
  const badge = SEVERITY_BADGES[payload.severity] ?? `[${payload.severity}]`;

  const fields: DiscordEmbedField[] = [
    {
      name: 'Contract ID',
      value: `\`${payload.contractId}\``,
      inline: true,
    },
    {
      name: 'Rule ID',
      value: `\`${payload.ruleId}\``,
      inline: true,
    },
    {
      name: 'Severity',
      value: `**${payload.severity}**`,
      inline: true,
    },
    {
      name: 'Alert ID',
      value: `\`${payload.alertId}\``,
      inline: false,
    },
  ];

  if (payload.explorerUrl) {
    fields.push({
      name: 'Stellar Explorer',
      value: `[View on StellarExpert](${payload.explorerUrl})`,
      inline: false,
    });
  }

  // Add metadata fields if present
  if (payload.metadata && Object.keys(payload.metadata).length > 0) {
    for (const [key, val] of Object.entries(payload.metadata)) {
      if (val !== undefined && val !== null) {
        const formattedKey = key
          .replace(/([A-Z])/g, ' $1')
          .replace(/^./, (str) => str.toUpperCase())
          .trim();

        const formattedVal =
          typeof val === 'object' ? JSON.stringify(val) : String(val);

        fields.push({
          name: formattedKey,
          value: `\`${formattedVal.slice(0, 1024)}\``,
          inline: true,
        });
      }
    }
  }

  const timestampIso =
    payload.timestamp instanceof Date
      ? payload.timestamp.toISOString()
      : new Date(payload.timestamp).toISOString();

  return {
    title: `${badge} ${payload.title}`,
    description: payload.message,
    url: payload.explorerUrl || undefined,
    color,
    fields,
    footer: {
      text: 'Soroban Watchdog • Exploits & Telemetry Engine',
      icon_url: 'https://stellar.org/favicon.ico',
    },
    timestamp: timestampIso,
  };
}

/**
 * Builds the complete Discord webhook message body.
 */
export function buildDiscordPayload(
  payload: AlertPayload,
  options?: { username?: string; avatarUrl?: string }
): DiscordWebhookPayload {
  return {
    username: options?.username || 'Soroban Watchdog',
    avatar_url:
      options?.avatarUrl ||
      'https://raw.githubusercontent.com/stellar/stellar-cli/main/assets/stellar-logo.png',
    embeds: [buildDiscordEmbed(payload)],
  };
}

/**
 * Validates whether a given destination URL is a valid Discord webhook URL.
 */
export function isValidDiscordWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    const isDiscordHost =
      host === 'discord.com' ||
      host === 'discordapp.com' ||
      host.endsWith('.discord.com') ||
      host.endsWith('.discordapp.com');

    return isDiscordHost && parsed.pathname.includes('/api/webhooks/');
  } catch {
    return false;
  }
}

/**
 * DiscordNotifier
 *
 * Plugin delivering rich, color-coded embed messages to Discord webhook channels.
 */
export class DiscordNotifier implements NotifierPlugin {
  readonly type = 'DISCORD' as const;
  private readonly timeoutMs: number;
  private readonly username?: string;
  private readonly avatarUrl?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DiscordNotifierOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.username = options.username;
    this.avatarUrl = options.avatarUrl;
    this.fetchImpl = options.fetchFn ?? globalThis.fetch;
  }

  /**
   * Dispatches an alert to a Discord webhook channel.
   *
   * @param payload The alert domain payload
   * @param destination Target Discord webhook URL
   */
  async send(payload: AlertPayload, destination: string): Promise<DeliveryResult> {
    const sentAt = new Date();

    if (!destination || typeof destination !== 'string') {
      return {
        success: false,
        error: 'Discord webhook destination URL is required and must be a string',
        sentAt,
      };
    }

    if (!isValidDiscordWebhookUrl(destination)) {
      return {
        success: false,
        error: `Invalid Discord webhook URL '${destination}'. Must be an https URL targeting /api/webhooks/`,
        sentAt,
      };
    }

    const discordPayload = buildDiscordPayload(payload, {
      username: this.username,
      avatarUrl: this.avatarUrl,
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(destination, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Soroban-Watchdog/0.1.0',
        },
        body: JSON.stringify(discordPayload),
        signal: controller.signal,
      });

      // Discord webhooks return 204 No Content upon success (or 200 OK)
      if (response.status === 204 || response.status === 200) {
        return {
          success: true,
          statusCode: response.status,
          sentAt,
        };
      }

      let errorDetail = '';
      try {
        const text = await response.text();
        errorDetail = text.slice(0, 300);
      } catch {
        // ignore
      }

      return {
        success: false,
        statusCode: response.status,
        error: `Discord webhook returned HTTP ${response.status} ${response.statusText}${
          errorDetail ? `: ${errorDetail}` : ''
        }`,
        sentAt,
      };
    } catch (err: any) {
      const isTimeout = err?.name === 'AbortError' || err?.message?.includes('aborted');
      return {
        success: false,
        error: isTimeout
          ? `Discord webhook request timed out after ${this.timeoutMs}ms`
          : `Discord webhook request failed: ${err.message}`,
        sentAt,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Factory to create a DiscordNotifier instance.
 */
export function createDiscordNotifier(options?: DiscordNotifierOptions): DiscordNotifier {
  return new DiscordNotifier(options);
}
