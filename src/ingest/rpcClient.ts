import { rpc } from '@stellar/stellar-sdk';
import { config } from '../config/env.js';

export interface RpcBackoffOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  jitter?: boolean;
}

export interface GetEventsParams {
  filters?: rpc.Api.EventFilter[];
  startLedger?: number;
  cursor?: string;
  limit?: number;
}

export interface SorobanRpcClientOptions {
  rpcUrl?: string;
  backoff?: RpcBackoffOptions;
  serverInstance?: rpc.Server;
}

/**
 * Checks whether an error from the Soroban RPC server or network is retryable.
 * Includes HTTP 429 (Too Many Requests), 5xx server errors, and network transport timeouts.
 */
export function isRetryableRpcError(error: any): boolean {
  if (!error) return false;

  const status = error.status || error.statusCode || error.response?.status;
  if (status === 429 || (status >= 500 && status <= 599)) {
    return true;
  }

  const code = error.code || error.response?.data?.error?.code;
  if (code === -32000 || code === -32005 || code === 429) {
    return true;
  }

  const message = String(error.message || '').toLowerCase();
  return (
    message.includes('429') ||
    message.includes('too many requests') ||
    message.includes('rate limit') ||
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    message.includes('etimedout') ||
    message.includes('timeout') ||
    message.includes('socket hang up') ||
    message.includes('fetch failed') ||
    message.includes('bad gateway') ||
    message.includes('service unavailable') ||
    message.includes('gateway timeout') ||
    message.includes('network')
  );
}

/**
 * Calculates exponential backoff delay with jitter.
 * Defaults to: 1s, 2s, 4s, 8s, up to 30s.
 */
export function calculateBackoffDelay(
  attempt: number,
  initialDelayMs: number = 1000,
  maxDelayMs: number = 30000,
  backoffFactor: number = 2,
  jitter: boolean = true
): number {
  const exponentialDelay = initialDelayMs * Math.pow(backoffFactor, attempt);
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);

  if (!jitter) {
    return cappedDelay;
  }

  // Jitter factor of +/- 20%
  const jitterRange = cappedDelay * 0.2;
  const randomizedOffset = (Math.random() * 2 - 1) * jitterRange;
  return Math.max(0, Math.floor(cappedDelay + randomizedOffset));
}

/**
 * High-resilience wrapper around @stellar/stellar-sdk's rpc.Server.
 * Provides cursor-based event fetching, ledger queries, and exponential backoff on 429 / 5xx errors.
 */
export class SorobanRpcClient {
  public readonly server: rpc.Server;
  public readonly rpcUrl: string;
  private readonly backoffConfig: Required<RpcBackoffOptions>;

  constructor(options: SorobanRpcClientOptions = {}) {
    this.rpcUrl = options.rpcUrl || config.SOROBAN_RPC_URL;
    this.server = options.serverInstance || new rpc.Server(this.rpcUrl, { allowHttp: true });

    this.backoffConfig = {
      maxRetries: options.backoff?.maxRetries ?? 5,
      initialDelayMs: options.backoff?.initialDelayMs ?? 1000,
      maxDelayMs: options.backoff?.maxDelayMs ?? 30000,
      backoffFactor: options.backoff?.backoffFactor ?? 2,
      jitter: options.backoff?.jitter ?? true,
    };
  }

  /**
   * Executes an asynchronous RPC operation with exponential backoff on retryable errors.
   */
  public async executeWithRetry<T>(
    operationName: string,
    operation: () => Promise<T>,
    customBackoff?: RpcBackoffOptions
  ): Promise<T> {
    const opts = { ...this.backoffConfig, ...customBackoff };
    let attempt = 0;

    while (true) {
      try {
        return await operation();
      } catch (error: any) {
        attempt++;

        const isRetryable = isRetryableRpcError(error);
        if (!isRetryable || attempt > opts.maxRetries) {
          throw error;
        }

        const delay = calculateBackoffDelay(
          attempt - 1,
          opts.initialDelayMs,
          opts.maxDelayMs,
          opts.backoffFactor,
          opts.jitter
        );

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * Fetches the latest ledger sequence and metadata from the Soroban RPC server.
   */
  public async getLatestLedger(): Promise<rpc.Api.GetLatestLedgerResponse> {
    return this.executeWithRetry('getLatestLedger', () => this.server.getLatestLedger());
  }

  /**
   * Fetches events with pagination and filters.
   * Note: In Soroban RPC, if `cursor` is provided, `startLedger` must NOT be sent.
   */
  public async getEvents(params: GetEventsParams): Promise<rpc.Api.GetEventsResponse> {
    const request: rpc.Server.GetEventsRequest = {
      filters: params.filters || [],
      limit: params.limit,
    };

    if (params.cursor) {
      request.cursor = params.cursor;
    } else if (params.startLedger !== undefined) {
      request.startLedger = params.startLedger;
    }

    return this.executeWithRetry('getEvents', () => this.server.getEvents(request));
  }
}

/**
 * Factory helper to instantiate SorobanRpcClient.
 */
export function createRpcClient(options?: SorobanRpcClientOptions): SorobanRpcClient {
  return new SorobanRpcClient(options);
}
