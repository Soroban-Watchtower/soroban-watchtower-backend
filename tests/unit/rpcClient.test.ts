import { describe, it, expect, vi } from 'vitest';
import {
  isRetryableRpcError,
  calculateBackoffDelay,
  SorobanRpcClient,
  createRpcClient,
} from '../../src/ingest/rpcClient.js';

describe('SorobanRpcClient & Resilience Logic', () => {
  describe('isRetryableRpcError', () => {
    it('should identify HTTP 429 as retryable', () => {
      expect(isRetryableRpcError({ status: 429 })).toBe(true);
      expect(isRetryableRpcError({ response: { status: 429 } })).toBe(true);
      expect(isRetryableRpcError(new Error('Rate limit exceeded: 429'))).toBe(true);
      expect(isRetryableRpcError(new Error('Too Many Requests'))).toBe(true);
    });

    it('should identify HTTP 5xx server errors as retryable', () => {
      expect(isRetryableRpcError({ status: 500 })).toBe(true);
      expect(isRetryableRpcError({ status: 502 })).toBe(true);
      expect(isRetryableRpcError({ status: 503 })).toBe(true);
      expect(isRetryableRpcError({ status: 504 })).toBe(true);
      expect(isRetryableRpcError(new Error('Bad Gateway'))).toBe(true);
      expect(isRetryableRpcError(new Error('Service Unavailable'))).toBe(true);
    });

    it('should identify transient network transport errors as retryable', () => {
      expect(isRetryableRpcError(new Error('connect ECONNREFUSED 127.0.0.1'))).toBe(true);
      expect(isRetryableRpcError(new Error('socket hang up'))).toBe(true);
      expect(isRetryableRpcError(new Error('ETIMEDOUT'))).toBe(true);
      expect(isRetryableRpcError(new Error('fetch failed'))).toBe(true);
    });

    it('should return false for non-retryable 4xx client errors', () => {
      expect(isRetryableRpcError({ status: 400 })).toBe(false);
      expect(isRetryableRpcError({ status: 401 })).toBe(false);
      expect(isRetryableRpcError({ status: 404 })).toBe(false);
      expect(isRetryableRpcError(new Error('Invalid parameters'))).toBe(false);
      expect(isRetryableRpcError(null)).toBe(false);
      expect(isRetryableRpcError(undefined)).toBe(false);
    });
  });

  describe('calculateBackoffDelay', () => {
    it('should calculate exponential delay without jitter', () => {
      const delay0 = calculateBackoffDelay(0, 1000, 30000, 2, false);
      const delay1 = calculateBackoffDelay(1, 1000, 30000, 2, false);
      const delay2 = calculateBackoffDelay(2, 1000, 30000, 2, false);
      const delay3 = calculateBackoffDelay(3, 1000, 30000, 2, false);

      expect(delay0).toBe(1000);
      expect(delay1).toBe(2000);
      expect(delay2).toBe(4000);
      expect(delay3).toBe(8000);
    });

    it('should cap delay at maxDelayMs', () => {
      const delayMax = calculateBackoffDelay(10, 1000, 30000, 2, false);
      expect(delayMax).toBe(30000);
    });

    it('should apply jitter within +/- 20% range', () => {
      const baseDelay = 10000;
      for (let i = 0; i < 20; i++) {
        const jittered = calculateBackoffDelay(0, baseDelay, 30000, 2, true);
        expect(jittered).toBeGreaterThanOrEqual(8000);
        expect(jittered).toBeLessThanOrEqual(12000);
      }
    });
  });

  describe('executeWithRetry', () => {
    it('should succeed on first attempt without retrying', async () => {
      const mockServer = {
        getLatestLedger: vi.fn().mockResolvedValue({ sequence: 12345 }),
      } as any;

      const client = new SorobanRpcClient({
        serverInstance: mockServer,
        backoff: { initialDelayMs: 1, maxRetries: 3 },
      });

      const result = await client.getLatestLedger();
      expect(result.sequence).toBe(12345);
      expect(mockServer.getLatestLedger).toHaveBeenCalledTimes(1);
    });

    it('should retry on 429 rate limit and resolve when subsequent attempt succeeds', async () => {
      const mockOp = vi
        .fn()
        .mockRejectedValueOnce({ status: 429, message: 'Too Many Requests' })
        .mockRejectedValueOnce({ status: 429, message: 'Too Many Requests' })
        .mockResolvedValueOnce({ success: true });

      const client = new SorobanRpcClient({
        serverInstance: {} as any,
        backoff: { initialDelayMs: 1, maxDelayMs: 10, maxRetries: 3 },
      });

      const result = await client.executeWithRetry('testOp', mockOp);
      expect(result).toEqual({ success: true });
      expect(mockOp).toHaveBeenCalledTimes(3);
    });

    it('should fail when maxRetries is exceeded', async () => {
      const mockOp = vi
        .fn()
        .mockRejectedValue({ status: 503, message: 'Service Unavailable' });

      const client = new SorobanRpcClient({
        serverInstance: {} as any,
        backoff: { initialDelayMs: 1, maxDelayMs: 10, maxRetries: 2 },
      });

      await expect(client.executeWithRetry('failingOp', mockOp)).rejects.toMatchObject({
        status: 503,
      });
      // 1 initial attempt + 2 retries = 3 calls
      expect(mockOp).toHaveBeenCalledTimes(3);
    });

    it('should fail immediately without retrying on non-retryable error', async () => {
      const mockOp = vi
        .fn()
        .mockRejectedValue({ status: 400, message: 'startLedger must be positive' });

      const client = new SorobanRpcClient({
        serverInstance: {} as any,
        backoff: { initialDelayMs: 1, maxRetries: 5 },
      });

      await expect(client.executeWithRetry('badReqOp', mockOp)).rejects.toMatchObject({
        status: 400,
      });
      expect(mockOp).toHaveBeenCalledTimes(1);
    });
  });

  describe('getEvents pagination parameters', () => {
    it('should send cursor without startLedger when cursor is provided', async () => {
      const mockGetEvents = vi.fn().mockResolvedValue({ latestLedger: 100, events: [] });
      const mockServer = { getEvents: mockGetEvents } as any;

      const client = new SorobanRpcClient({ serverInstance: mockServer });

      await client.getEvents({
        cursor: '000100-0-0',
        filters: [{ type: 'contract', contractIds: ['CA3D5...'] }],
        limit: 50,
      });

      expect(mockGetEvents).toHaveBeenCalledWith({
        cursor: '000100-0-0',
        filters: [{ type: 'contract', contractIds: ['CA3D5...'] }],
        limit: 50,
      });
    });

    it('should send startLedger when no cursor is provided', async () => {
      const mockGetEvents = vi.fn().mockResolvedValue({ latestLedger: 100, events: [] });
      const mockServer = { getEvents: mockGetEvents } as any;

      const client = new SorobanRpcClient({ serverInstance: mockServer });

      await client.getEvents({
        startLedger: 950,
        filters: [{ type: 'contract', contractIds: ['CA3D5...'] }],
        limit: 100,
      });

      expect(mockGetEvents).toHaveBeenCalledWith({
        startLedger: 950,
        filters: [{ type: 'contract', contractIds: ['CA3D5...'] }],
        limit: 100,
      });
    });
  });
});
