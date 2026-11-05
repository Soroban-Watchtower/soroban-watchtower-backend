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

  describe('Multi-Contract Batch Ingestion (pollBatch)', () => {
    it('should query up to 5 contracts in a single RPC getEvents call and demultiplex events per contract', async () => {
      const contract1 = 'CA11111111111111111111111111111111111111111111111111111111';
      const contract2 = 'CA22222222222222222222222222222222222222222222222222222222';
      const contract3 = 'CA33333333333333333333333333333333333333333333333333333333';

      const mockEvents = [
        {
          id: '006000-0-0',
          contractId: contract1,
          type: 'contract',
          ledger: 6000,
          ledgerClosedAt: '2026-10-24T00:00:00Z',
          txHash: 'hash-c1-1',
          topic: [],
          value: null,
          rawXdr: 'xdr-c1',
        },
        {
          id: '006001-0-0',
          contractId: contract2,
          type: 'contract',
          ledger: 6001,
          ledgerClosedAt: '2026-10-24T00:00:00Z',
          txHash: 'hash-c2-1',
          topic: [],
          value: null,
          rawXdr: 'xdr-c2',
        },
      ];

      const mockRpcClient = {
        getLatestLedger: vi.fn().mockResolvedValue({ sequence: 6050 }),
        getEvents: vi.fn().mockResolvedValue({
          latestLedger: 6050,
          events: mockEvents,
        }),
      } as any;

      const mockCursorManager = {
        getCursor: vi.fn().mockImplementation((cId: string) => {
          if (cId === contract1) return Promise.resolve({ cursor: 'c1-prev', lastLedgerSequence: 5990n });
          if (cId === contract2) return Promise.resolve({ cursor: 'c2-prev', lastLedgerSequence: 5995n });
          return Promise.resolve(null); // contract3 has no cursor
        }),
        saveEventsAndCursor: vi.fn().mockResolvedValue(undefined),
        updateCursorOnly: vi.fn().mockResolvedValue(undefined),
      } as any;

      const onPersisted = vi.fn();

      const poller = new IngestionPoller({
        contractIds: [contract1, contract2, contract3],
        rpcClient: mockRpcClient,
        cursorManager: mockCursorManager,
        onEventsPersisted: onPersisted,
        startLedgerOffset: 100,
      });

      const batchResult = await poller.pollBatch([contract1, contract2, contract3]);

      // Exactly 1 RPC call made for all 3 contracts combined
      expect(mockRpcClient.getEvents).toHaveBeenCalledTimes(1);
      expect(mockRpcClient.getEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: [{ type: 'contract', contractIds: [contract1, contract2, contract3] }],
        })
      );

      expect(batchResult.totalEventsFetched).toBe(2);
      expect(batchResult.contractIds).toEqual([contract1, contract2, contract3]);

      // Contract 1: event saved
      expect(mockCursorManager.saveEventsAndCursor).toHaveBeenCalledWith(
        contract1,
        expect.any(Array),
        '006000-0-0',
        6000n,
        6050n,
        '006000-0-0'
      );

      // Contract 2: event saved
      expect(mockCursorManager.saveEventsAndCursor).toHaveBeenCalledWith(
        contract2,
        expect.any(Array),
        '006001-0-0',
        6001n,
        6050n,
        '006001-0-0'
      );

      // Contract 3 had no events: cursor updated to latest ledger sequence
      expect(mockCursorManager.updateCursorOnly).toHaveBeenCalledWith(
        contract3,
        null,
        6050n,
        6050n
      );

      expect(onPersisted).toHaveBeenCalledTimes(2);
      expect(batchResult.resultsByContract.get(contract1)?.eventsFetched).toBe(1);
      expect(batchResult.resultsByContract.get(contract2)?.eventsFetched).toBe(1);
      expect(batchResult.resultsByContract.get(contract3)?.eventsFetched).toBe(0);
    });
  });

  describe('Dynamic Contract Synchronization & Live Event Bus', () => {
    it('should dynamically add and remove contracts from monitoring via API event bus', async () => {
      const poller = new IngestionPoller({
        contractIds: ['C_INITIAL'],
        dynamicSync: true,
      });

      expect(poller.getMonitoredContracts()).toEqual(['C_INITIAL']);

      // Simulate POST /api/v1/contracts event
      poller.addContract('C_DYNAMIC_NEW');
      expect(poller.getMonitoredContracts()).toContain('C_DYNAMIC_NEW');
      expect(poller.getMonitoredContracts().length).toBe(2);

      // Simulate DELETE /api/v1/contracts/:id event
      poller.removeContract('C_INITIAL');
      expect(poller.getMonitoredContracts()).not.toContain('C_INITIAL');
      expect(poller.getMonitoredContracts()).toEqual(['C_DYNAMIC_NEW']);
    });

    it('should periodically sync active contracts from PostgreSQL without server restart', async () => {
      const mockPrisma = {
        contract: {
          findMany: vi.fn().mockResolvedValue([
            { id: 'C_DB_ALPHA' },
            { id: 'C_DB_BETA' },
          ]),
        },
      } as any;

      const poller = new IngestionPoller({
        contractIds: ['C_INITIAL'],
        prismaClient: mockPrisma,
        dynamicSync: true,
      });

      const synced = await poller.syncContractsFromDb();

      expect(mockPrisma.contract.findMany).toHaveBeenCalledWith({
        where: { active: true },
        select: { id: true },
      });
      expect(synced).toContain('C_DB_ALPHA');
      expect(synced).toContain('C_DB_BETA');
      expect(poller.getMonitoredContracts()).toContain('C_DB_ALPHA');
      expect(poller.getMonitoredContracts()).toContain('C_DB_BETA');
    });
  });

  describe('Concurrent Worker Sharding & High-Volume Isolation', () => {
    it('should partition contracts across worker shards and assign high-volume contracts to dedicated shards', () => {
      const normalContracts = [
        'C_CONTRACT_1',
        'C_CONTRACT_2',
        'C_CONTRACT_3',
        'C_CONTRACT_4',
      ];
      const highVolumeContract = 'C_HIGH_VOLUME_USDC_POOL';

      const poller = new IngestionPoller({
        contractIds: [...normalContracts, highVolumeContract],
        shardCount: 2,
        highVolumeContractIds: [highVolumeContract],
      });

      const shards = poller.getShards();
      expect(shards.length).toBeGreaterThanOrEqual(3); // 2 standard shards + 1 dedicated HV shard

      const dedicatedShard = shards.find((s) => s.isDedicated);
      expect(dedicatedShard).toBeDefined();
      expect(dedicatedShard?.contractIds.has(highVolumeContract)).toBe(true);
      expect(dedicatedShard?.contractIds.size).toBe(1);

      // Verify normal contracts are partitioned across standard shards
      const standardShards = shards.filter((s) => !s.isDedicated);
      expect(standardShards.length).toBe(2);
      const totalInStandard = standardShards.reduce((acc, s) => acc + s.contractIds.size, 0);
      expect(totalInStandard).toBe(4);
    });
  });
});
