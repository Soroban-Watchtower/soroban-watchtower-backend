import { describe, it, expect, vi } from 'vitest';
import { IngestionPoller } from '../../src/ingest/poller.js';

describe('IngestionPoller Workflow', () => {
  it('should query with startLedger = latest - offset when no cursor exists', async () => {
    const mockRpcClient = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 5000 }),
      getEvents: vi.fn().mockResolvedValue({
        latestLedger: 5000,
        events: [
          {
            id: '004950-0-0',
            contractId: 'C_CONTRACT',
            type: 'contract',
            ledger: 4950,
            ledgerClosedAt: '2026-10-24T00:00:00Z',
            txHash: 'hash1',
            topic: [],
            value: null,
            rawXdr: 'xdr1',
          },
        ],
      }),
    } as any;

    const mockCursorManager = {
      getCursor: vi.fn().mockResolvedValue(null),
      saveEventsAndCursor: vi.fn().mockResolvedValue(undefined),
      updateCursorOnly: vi.fn().mockResolvedValue(undefined),
    } as any;

    const onPersisted = vi.fn();

    const poller = new IngestionPoller({
      contractIds: ['C_CONTRACT'],
      batchSize: 50,
      startLedgerOffset: 100,
      rpcClient: mockRpcClient,
      cursorManager: mockCursorManager,
      onEventsPersisted: onPersisted,
    });

    const result = await poller.pollContract('C_CONTRACT');

    expect(mockCursorManager.getCursor).toHaveBeenCalledWith('C_CONTRACT');
    expect(mockRpcClient.getLatestLedger).toHaveBeenCalledTimes(1);

    // 5000 - 100 = 4900
    expect(mockRpcClient.getEvents).toHaveBeenCalledWith({
      startLedger: 4900,
      filters: [{ type: 'contract', contractIds: ['C_CONTRACT'] }],
      limit: 50,
    });

    expect(mockCursorManager.saveEventsAndCursor).toHaveBeenCalledWith(
      'C_CONTRACT',
      expect.arrayContaining([
        expect.objectContaining({
          id: '004950-0-0',
          contractId: 'C_CONTRACT',
        }),
      ]),
      '004950-0-0',
      4950n,
      5000n,
      '004950-0-0'
    );

    expect(onPersisted).toHaveBeenCalledTimes(1);
    expect(result.eventsFetched).toBe(1);
    expect(result.hasMore).toBe(false); // 1 < batchSize (50)
  });

  it('should query with cursor (and omit startLedger) when cursor exists', async () => {
    const mockRpcClient = {
      getLatestLedger: vi.fn(),
      getEvents: vi.fn().mockResolvedValue({
        latestLedger: 5200,
        events: [
          {
            id: '005100-0-0',
            contractId: 'C_CONTRACT',
            type: 'contract',
            ledger: 5100,
            ledgerClosedAt: '2026-10-24T01:00:00Z',
            txHash: 'hash2',
            topic: [],
            value: null,
            rawXdr: 'xdr2',
          },
        ],
      }),
    } as any;

    const mockCursorManager = {
      getCursor: vi.fn().mockResolvedValue({
        cursor: '005050-0-0',
        lastLedgerSequence: 5050n,
      }),
      saveEventsAndCursor: vi.fn().mockResolvedValue(undefined),
      updateCursorOnly: vi.fn().mockResolvedValue(undefined),
    } as any;

    const poller = new IngestionPoller({
      contractIds: ['C_CONTRACT'],
      batchSize: 10,
      rpcClient: mockRpcClient,
      cursorManager: mockCursorManager,
    });

    const result = await poller.pollContract('C_CONTRACT');

    expect(mockRpcClient.getLatestLedger).not.toHaveBeenCalled();
    expect(mockRpcClient.getEvents).toHaveBeenCalledWith({
      cursor: '005050-0-0',
      filters: [{ type: 'contract', contractIds: ['C_CONTRACT'] }],
      limit: 10,
    });

    expect(mockCursorManager.saveEventsAndCursor).toHaveBeenCalledWith(
      'C_CONTRACT',
      expect.any(Array),
      '005100-0-0',
      5100n,
      5200n,
      '005100-0-0'
    );

    expect(result.newCursor).toBe('005100-0-0');
  });

  it('should signal hasMore = true when full page of events is returned', async () => {
    const mockEvents = Array.from({ length: 5 }, (_, i) => ({
      id: `evt-${i}`,
      contractId: 'C_CONTRACT',
      type: 'contract',
      ledger: 5000 + i,
      ledgerClosedAt: '2026-10-24T00:00:00Z',
      txHash: `hash-${i}`,
      topic: [],
      value: null,
      rawXdr: 'xdr',
    }));

    const mockRpcClient = {
      getEvents: vi.fn().mockResolvedValue({
        latestLedger: 5010,
        events: mockEvents,
      }),
    } as any;

    const mockCursorManager = {
      getCursor: vi.fn().mockResolvedValue({ cursor: 'evt-start', lastLedgerSequence: 4999n }),
      saveEventsAndCursor: vi.fn().mockResolvedValue(undefined),
      updateCursorOnly: vi.fn().mockResolvedValue(undefined),
    } as any;

    const poller = new IngestionPoller({
      contractIds: ['C_CONTRACT'],
      batchSize: 5,
      rpcClient: mockRpcClient,
      cursorManager: mockCursorManager,
    });

    const result = await poller.pollContract('C_CONTRACT');

    expect(result.eventsFetched).toBe(5);
    expect(result.hasMore).toBe(true);
    expect(result.newCursor).toBe('evt-4');
  });

  it('should call updateCursorOnly when no new events are found', async () => {
    const mockRpcClient = {
      getEvents: vi.fn().mockResolvedValue({
        latestLedger: 5500,
        events: [],
      }),
    } as any;

    const mockCursorManager = {
      getCursor: vi.fn().mockResolvedValue({ cursor: 'curr-cursor', lastLedgerSequence: 5400n }),
      saveEventsAndCursor: vi.fn(),
      updateCursorOnly: vi.fn().mockResolvedValue({}),
    } as any;

    const poller = new IngestionPoller({
      contractIds: ['C_CONTRACT'],
      rpcClient: mockRpcClient,
      cursorManager: mockCursorManager,
    });

    const result = await poller.pollContract('C_CONTRACT');

    expect(mockCursorManager.saveEventsAndCursor).not.toHaveBeenCalled();
    expect(mockCursorManager.updateCursorOnly).toHaveBeenCalledWith('C_CONTRACT', 'curr-cursor', 5500n, 5500n);
    expect(result.eventsFetched).toBe(0);
    expect(result.hasMore).toBe(false);
  });
});
