import {
  AlertPayload,
  DeliveryResult,
  NotifierPlugin,
  Severity,
} from '../types/index.js';
import { validateSsrf, SsrfValidationOptions } from './ssrfValidator.js';

export const DEFAULT_PAGERDUTY_EVENTS_URL = 'https://events.pagerduty.com/v2/enqueue';

export interface PagerDutyNotifierOptions {
  timeoutMs?: number;
  eventsUrl?: string;
  ssrfOptions?: SsrfValidationOptions;
  fetchFn?: typeof fetch;
}

export type PagerDutySeverity = 'critical' | 'error' | 'warning' | 'info';

const SEVERITY_MAP: Record<Severity, PagerDutySeverity> = {
  CRITICAL: 'critical',
  HIGH: 'error',
  MEDIUM: 'warning',
  LOW: 'info',
};

/**
 * PagerDutyNotifier
 *
 * Dispatches incident trigger events to PagerDuty Events API v2.
 * Natively supports dedup keys, severity mapping, custom metadata, and explorer links.
 */
export class PagerDutyNotifier implements NotifierPlugin {
  readonly type = 'PAGERDUTY' as const;
  private readonly timeoutMs: number;
  private readonly defaultEventsUrl: string;
  private readonly ssrfOptions?: SsrfValidationOptions;
  private readonly fetch: typeof fetch;

  constructor(options: PagerDutyNotifierOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.defaultEventsUrl = options.eventsUrl ?? DEFAULT_PAGERDUTY_EVENTS_URL;
    this.ssrfOptions = options.ssrfOptions;
    this.fetch = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  async send(
    payload: AlertPayload,
    destination: string,
    secret?: string
  ): Promise<DeliveryResult> {
    if (!destination || !destination.trim()) {
      return {
        success: false,
        error: 'PagerDuty routing key or endpoint destination cannot be empty',
        sentAt: new Date(),
      };
    }

    let endpoint = this.defaultEventsUrl;
    let routingKey = destination.trim();

    // If destination is a full URL, use it as endpoint and secret as routing key
    if (destination.startsWith('http://') || destination.startsWith('https://')) {
      endpoint = destination.trim();
      routingKey = secret?.trim() || '';
    } else if (secret && secret.trim()) {
      routingKey = secret.trim();
    }

    if (!routingKey) {
      return {
        success: false,
        error: 'PagerDuty routing key is missing. Specify routing key in destination or secret.',
        sentAt: new Date(),
      };
    }

    // SSRF Validation on destination endpoint
    const ssrfResult = await validateSsrf(endpoint, this.ssrfOptions);
    if (!ssrfResult.isValid) {
      return {
        success: false,
        error: `SSRF validation failed: ${ssrfResult.error}`,
        sentAt: new Date(),
      };
    }

    const pdSeverity = SEVERITY_MAP[payload.severity] || 'warning';
    const timestampStr = payload.timestamp instanceof Date
      ? payload.timestamp.toISOString()
      : new Date(payload.timestamp).toISOString();

    const pdPayload = {
      routing_key: routingKey,
      event_action: 'trigger',
      dedup_key: `soroban-${payload.contractId}-${payload.ruleId}`,
      payload: {
        summary: `[${payload.severity}] ${payload.title} on ${payload.contractId}`,
        source: payload.contractId,
        severity: pdSeverity,
        timestamp: timestampStr,
        component: 'soroban-smart-contract',
        group: 'security-watchtower',
        class: payload.metadata?.detectorType || 'security-anomaly',
        custom_details: {
          contractId: payload.contractId,
          ruleId: payload.ruleId,
          message: payload.message,
          title: payload.title,
          ...payload.metadata,
        },
      },
      links: payload.explorerUrl
        ? [
            {
              href: payload.explorerUrl,
              text: 'View on Stellar Expert',
            },
          ]
        : [],
      client: 'Soroban Watchdog',
      client_url: payload.explorerUrl || undefined,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Soroban-Watchdog/0.1.0',
        },
        body: JSON.stringify(pdPayload),
        signal: controller.signal,
      });

      clearTimeout(timer);

      // PagerDuty returns 202 Accepted on success
      if (response.status === 202 || response.ok) {
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
        error: `PagerDuty API responded with status ${response.status}: ${responseBody}`,
        sentAt: new Date(),
      };
    } catch (dispatchError: any) {
      clearTimeout(timer);
      const isTimeout = dispatchError.name === 'AbortError';
      const errorMessage = isTimeout
        ? `PagerDuty delivery timed out after ${this.timeoutMs}ms`
        : dispatchError.message ?? 'Unknown PagerDuty dispatch error';

      return {
        success: false,
        error: errorMessage,
        sentAt: new Date(),
      };
    }
  }
}

