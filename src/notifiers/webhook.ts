import crypto from 'node:crypto';
import {
  AlertPayload,
  DeliveryResult,
  NotifierPlugin,
} from '../types/index.js';
import {
  validateSsrf,
  SsrfValidationOptions,
} from './ssrfValidator.js';

export interface WebhookNotifierOptions {
  /**
   * Timeout in milliseconds for outgoing webhook POST requests (default: 10,000ms).
   */
  timeoutMs?: number;
  /**
   * SSRF validation options.
   */
  ssrfOptions?: SsrfValidationOptions;
  /**
   * Optional custom fetch implementation (useful for unit tests and mocking).
   */
  fetchFn?: typeof fetch;
}

/**
 * Computes an HMAC-SHA256 signature over a serialized payload string using a shared secret.
 *
 * @param payload The raw string or object payload to sign
 * @param secret The pre-shared secret key
 * @returns Hex-encoded HMAC-SHA256 digest
 */
export function computeWebhookSignature(payload: string | object, secret: string): string {
  const content = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return crypto.createHmac('sha256', secret).update(content).digest('hex');
}

/**
 * Verifies that an incoming X-Watchdog-Signature header matches the computed HMAC-SHA256 digest.
 * Employs timing-safe equality to mitigate timing side-channel attacks.
 * Accepts both `sha256=<hex>` and raw `<hex>` header formats.
 *
 * @param payload The raw string or object payload to verify
 * @param signatureHeader The received X-Watchdog-Signature header string
 * @param secret The pre-shared secret key
 * @returns True if signature is cryptographically valid, false otherwise
 */
export function verifyWebhookSignature(
  payload: string | object,
  signatureHeader: string,
  secret: string
): boolean {
  if (!signatureHeader || !secret) {
    return false;
  }

  const expectedHex = computeWebhookSignature(payload, secret);
  const cleanHeader = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice('sha256='.length)
    : signatureHeader;

  if (cleanHeader.length !== expectedHex.length) {
    return false;
  }

  try {
    const expectedBuf = Buffer.from(expectedHex, 'hex');
    const actualBuf = Buffer.from(cleanHeader, 'hex');
    return crypto.timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

/**
 * WebhookNotifier
 *
 * Plugin delivering raw JSON alert payloads to custom webhook endpoints.
 * Features:
 * - Strict SSRF validation blocking private, loopback, and internal CIDRs.
 * - Cryptographic HMAC-SHA256 signing via `X-Watchdog-Signature` header.
 * - Configurable request timeout with graceful error handling.
 */
export class WebhookNotifier implements NotifierPlugin {
  readonly type = 'WEBHOOK' as const;
  private readonly timeoutMs: number;
  private readonly ssrfOptions?: SsrfValidationOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: WebhookNotifierOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.ssrfOptions = options.ssrfOptions;
    this.fetchImpl = options.fetchFn ?? globalThis.fetch;
  }

  /**
   * Dispatches an alert payload to a custom webhook URL.
   *
   * @param payload The alert domain payload
   * @param destination Target HTTP(S) URL
   * @param secret Optional shared secret for HMAC-SHA256 signature
   */
  async send(
    payload: AlertPayload,
    destination: string,
    secret?: string
  ): Promise<DeliveryResult> {
    const sentAt = new Date();

    if (!destination || typeof destination !== 'string') {
      return {
        success: false,
        error: 'Webhook destination URL is required and must be a string',
        sentAt,
      };
    }

    // 1. SSRF Protection: Validate target destination URL
    const ssrfResult = await validateSsrf(destination, this.ssrfOptions);
    if (!ssrfResult.isValid) {
      return {
        success: false,
        error: `SSRF validation blocked request: ${ssrfResult.error}`,
        sentAt,
      };
    }

    // 2. Prepare payload and signature
    const bodyString = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Soroban-Watchdog/0.1.0',
      'X-Watchdog-Alert-Id': payload.alertId,
      'X-Watchdog-Timestamp': sentAt.toISOString(),
    };

    if (secret) {
      const signatureHex = computeWebhookSignature(bodyString, secret);
      // Include both standard sha256= format and hex
      headers['X-Watchdog-Signature'] = `sha256=${signatureHex}`;
    }

    // 3. Dispatch POST request with abort controller timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(destination, {
        method: 'POST',
        headers,
        body: bodyString,
        signal: controller.signal,
      });

      if (response.ok) {
        return {
          success: true,
          statusCode: response.status,
          sentAt,
        };
      } else {
        let responseBodySnippet = '';
        try {
          const text = await response.text();
          responseBodySnippet = text.slice(0, 200);
        } catch {
          // ignore error reading body
        }

        return {
          success: false,
          statusCode: response.status,
          error: `Webhook destination returned HTTP ${response.status} ${response.statusText}${
            responseBodySnippet ? `: ${responseBodySnippet}` : ''
          }`,
          sentAt,
        };
      }
    } catch (err: any) {
      const isTimeout = err?.name === 'AbortError' || err?.message?.includes('aborted');
      return {
        success: false,
        error: isTimeout
          ? `Webhook request timed out after ${this.timeoutMs}ms`
          : `Webhook request failed: ${err.message}`,
        sentAt,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Factory to create a WebhookNotifier instance.
 */
export function createWebhookNotifier(options?: WebhookNotifierOptions): WebhookNotifier {
  return new WebhookNotifier(options);
}
