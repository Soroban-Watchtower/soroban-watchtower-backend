import {
  AlertPayload,
  DeliveryResult,
  NotifierPlugin,
  Severity,
} from '../types/index.js';

export interface TelegramNotifierOptions {
  timeoutMs?: number;
  botToken?: string;
  fetchFn?: typeof fetch;
}

const SEVERITY_ICONS: Record<Severity, string> = {
  CRITICAL: '🚨 *[CRITICAL]*',
  HIGH: '⚠️ *[HIGH]*',
  MEDIUM: '🟡 *[MEDIUM]*',
  LOW: '🟢 *[LOW]*',
};

/**
 * TelegramNotifier
 *
 * Plugin delivering formatted Markdown alert notifications to Telegram chats via Telegram Bot API.
 */
export class TelegramNotifier implements NotifierPlugin {
  readonly type = 'TELEGRAM' as const;
  private readonly timeoutMs: number;
  private readonly defaultBotToken?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TelegramNotifierOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.defaultBotToken = options.botToken;
    this.fetchImpl = options.fetchFn ?? globalThis.fetch;
  }

  /**
   * Dispatches an alert to Telegram.
   *
   * @param payload Alert domain payload
   * @param destination Target Telegram Chat ID (e.g. -100123456789 or @channel) or full webhook URL
   * @param secret Bot token (if not provided, falls back to defaultBotToken)
   */
  async send(
    payload: AlertPayload,
    destination: string,
    secret?: string
  ): Promise<DeliveryResult> {
    const sentAt = new Date();

    if (!destination) {
      return {
        success: false,
        error: 'Telegram destination (chat_id) is required',
        sentAt,
      };
    }

    const token = secret || this.defaultBotToken;
    let url: string;

    if (destination.startsWith('https://api.telegram.org/')) {
      url = destination;
    } else {
      if (!token) {
        return {
          success: false,
          error: 'Telegram bot token is required (via secret or defaultBotToken)',
          sentAt,
        };
      }
      url = `https://api.telegram.org/bot${token}/sendMessage`;
    }

    const icon = SEVERITY_ICONS[payload.severity] ?? `*[${payload.severity}]*`;
    const messageLines = [
      `${icon} *Soroban Watchdog Alert*`,
      ``,
      `*Title:* ${payload.title}`,
      `*Message:* ${payload.message}`,
      `*Contract:* \`${payload.contractId}\``,
      `*Rule ID:* \`${payload.ruleId}\``,
      `*Severity:* ${payload.severity}`,
      `*Alert ID:* \`${payload.alertId}\``,
    ];

    if (payload.explorerUrl) {
      messageLines.push(`*Explorer:* [StellarExpert](${payload.explorerUrl})`);
    }

    const text = messageLines.join('\n');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Soroban-Watchdog/0.1.0',
        },
        body: JSON.stringify({
          chat_id: destination.startsWith('https://') ? undefined : destination,
          text,
          parse_mode: 'Markdown',
          disable_web_page_preview: false,
        }),
        signal: controller.signal,
      });

      if (response.ok) {
        return {
          success: true,
          statusCode: response.status,
          sentAt,
        };
      }

      let errorText = '';
      try {
        errorText = (await response.text()).slice(0, 300);
      } catch {
        // ignore
      }

      return {
        success: false,
        statusCode: response.status,
        error: `Telegram API returned HTTP ${response.status}: ${errorText}`,
        sentAt,
      };
    } catch (err: any) {
      return {
        success: false,
        error: `Telegram request failed: ${err.message}`,
        sentAt,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export function createTelegramNotifier(options?: TelegramNotifierOptions): TelegramNotifier {
  return new TelegramNotifier(options);
}
