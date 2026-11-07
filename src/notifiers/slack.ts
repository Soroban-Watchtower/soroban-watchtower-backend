import {
  AlertPayload,
  DeliveryResult,
  NotifierPlugin,
  Severity,
} from '../types/index.js';
import { validateSsrf, SsrfValidationOptions } from './ssrfValidator.js';

export interface SlackNotifierOptions {
  timeoutMs?: number;
  ssrfOptions?: SsrfValidationOptions;
  fetchFn?: typeof fetch;
}

const SEVERITY_EMOJIS: Record<Severity, string> = {
  CRITICAL: '🚨',
  HIGH: '⚠️',
  MEDIUM: '⚡',
  LOW: 'ℹ️',
};

/**
 * Builds a Slack Block Kit payload from an AlertPayload.
 */
export function buildSlackBlockKitPayload(payload: AlertPayload) {
  const emoji = SEVERITY_EMOJIS[payload.severity] || '🛡️';
  const timestampStr = payload.timestamp instanceof Date
    ? payload.timestamp.toUTCString()
    : new Date(payload.timestamp).toUTCString();

  const blocks: any[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${emoji} [${payload.severity}] ${payload.title}`,
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Message:*\n${payload.message}`,
      },
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*Contract:*\n\`${payload.contractId}\``,
        },
        {
          type: 'mrkdwn',
          text: `*Rule ID:*\n\`${payload.ruleId}\``,
        },
        {
          type: 'mrkdwn',
          text: `*Severity:*\n*${payload.severity}*`,
        },
        {
          type: 'mrkdwn',
          text: `*Timestamp:*\n${timestampStr}`,
        },
      ],
    },
  ];

  // Optional Explorer Action Button
  if (payload.explorerUrl) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'View on Stellar Expert',
            emoji: true,
          },
          url: payload.explorerUrl,
          style: payload.severity === 'CRITICAL' ? 'danger' : 'primary',
        },
      ],
    });
  }

  // Footer Context
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: '🛡️ *Soroban Watchdog* Enterprise Anomaly Surveillance',
      },
    ],
  });

  return {
    text: `[${payload.severity}] ${payload.title} - ${payload.contractId}`,
    blocks,
  };
}

/**
 * SlackNotifier
 *
 * Dispatches enterprise security alerts to Slack incoming webhooks using formatted Block Kit.
 * Hardened with SSRF validation, configurable timeouts, and error handling.
 */
export class SlackNotifier implements NotifierPlugin {
  readonly type = 'SLACK' as const;
  private readonly timeoutMs: number;
  private readonly ssrfOptions?: SsrfValidationOptions;
  private readonly fetch: typeof fetch;

  constructor(options: SlackNotifierOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.ssrfOptions = options.ssrfOptions;
    this.fetch = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  async send(
    payload: AlertPayload,
    destination: string,
    _secret?: string
  ): Promise<DeliveryResult> {
    if (!destination || !destination.trim()) {
      return {
        success: false,
        error: 'Slack webhook URL destination cannot be empty',
        sentAt: new Date(),
      };
    }

    // SSRF Validation
    const ssrfResult = await validateSsrf(destination, this.ssrfOptions);
    if (!ssrfResult.isValid) {
      return {
        success: false,
        error: `SSRF validation failed: ${ssrfResult.error}`,
        sentAt: new Date(),
      };
    }

    const slackPayload = buildSlackBlockKitPayload(payload);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetch(destination, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Soroban-Watchdog/0.1.0',
        },
        body: JSON.stringify(slackPayload),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (response.ok) {
        return {
          success: true,
          statusCode: response.status,
          sentAt: new Date(),
        };
      }

      const responseBody = await response.text();
      return {
        success: false,
        statusCode: response.status,
        error: `Slack webhook responded with status ${response.status}: ${responseBody}`,
        sentAt: new Date(),
      };
    } catch (dispatchError: any) {
      clearTimeout(timer);
      const isTimeout = dispatchError.name === 'AbortError';
      const errorMessage = isTimeout
        ? `Slack delivery timed out after ${this.timeoutMs}ms`
        : dispatchError.message ?? 'Unknown Slack dispatch error';

      return {
        success: false,
        error: errorMessage,
        sentAt: new Date(),
      };
    }
  }
}

