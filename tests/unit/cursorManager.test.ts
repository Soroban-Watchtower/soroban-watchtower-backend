import { describe, it, expect, vi } from 'vitest';
import {
  CursorManager,
  serializeBigIntForJson,
} from '../../src/ingest/cursorManager.js';
import { DecodedSorobanEvent } from '../../src/types/index.js';

describe('CursorManager & Persistence Layer', () => {
  describe('serializeBigIntForJson', () => {
    it('should serialize BigInt primitive to string', () => {
      expect(serializeBigIntForJson(1005000000n)).toBe('1005000000');
    });

    it('should recursively serialize BigInts in nested arrays and objects', () => {
      const complex = {
        amount: 5000000000000000000n,
        topics: ['transfer', 12345n, 'USDC'],
        nested: {
          balance: 999n,
          label: 'vault',
        },
      };

      const serialized = serializeBigIntForJson(complex);
      expect(serialized).toEqual({
        amount: '5000000000000000000',
        topics: ['transfer', '12345', 'USDC'],
        nested: {
          balance: '999',
          label: 'vault',
        },
      });

      // Verify it can safely be stringified without TypeError: Do not know how to serialize a BigInt
      expect(() => JSON.stringify(serialized)).not.toThrow();
    });

    it('should leave strings, numbers, booleans, and null untouched', () => {
      expect(serializeBigIntForJson('test')).toBe('test');
      expect(serializeBigIntForJson(42)).toBe(42);
      expect(serializeBigIntForJson(true)).toBe(true);
      expect(serializeBigIntForJson(null)).toBe(null);
      expect(serializeBigIntForJson(undefined)).toBe(undefined);
    });
  });

  describe('getCursor', () => {
    it('should return null when no ingestion state exists for contract', async () => {
      const mockPrisma = {
        ingestionState: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      } as any;

      const manager = new CursorManager(mockPrisma);
      const result = await manager.getCursor('CA3D5...');

      expect(result).toBeNull();
      expect(mockPrisma.ingestionState.findUnique).toHaveBeenCalledWith({
        where: { contractId: 'CA3D5...' },
      });
    });

    it('should return cursor and lastLedgerSequence when record exists', async () => {
      const mockPrisma = {
        ingestionState: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'state-1',
            contractId: 'CA3D5...',
            cursor: '000123-0-0',
            lastLedgerSequence: 5000000n,
          }),
        },
      } as any;

      const manager = new CursorManager(mockPrisma);
      const result = await manager.getCursor('CA3D5...');

      expect(result).toEqual(
        expect.objectContaining({
          cursor: '000123-0-0',
          lastLedgerSequence: 5000000n,
        })
      );
    });
  });

  describe('checkLedgerGap', () => {
    it('should detect a gap when oldest RPC ledger is greater than current cursor ledger', () => {
      const manager = new CursorManager({} as any);
      const gap = manager.checkLedgerGap('CA3D5...', 1000n, 1050n);

      expect(gap.gapDetected).toBe(true);
      expect(gap.missingLedgersCount).toBe(50n);
      expect(gap.oldestRpcLedger).toBe(1050n);
      expect(gap.currentCursorLedger).toBe(1000n);
    });

    it('should not detect a gap when oldest RPC ledger is equal to or less than cursor ledger', () => {
      const manager = new CursorManager({} as any);
      const gap = manager.checkLedgerGap('CA3D5...', 1050n, 1000n);

      expect(gap.gapDetected).toBe(false);
      expect(gap.missingLedgersCount).toBe(0n);
    });

    it('should not detect a gap when cursor ledger is zero (initial sync)', () => {
      const manager = new CursorManager({} as any);
      const gap = manager.checkLedgerGap('CA3D5...', 0n, 1000n);

      expect(gap.gapDetected).toBe(false);
    });
  });

  describe('saveEventsAndCursor', () => {
    it('should execute inside an interactive transaction with skipDuplicates: true', async () => {
      const mockContractUpsert = vi.fn().mockResolvedValue({});
      const mockEventCreateMany = vi.fn().mockResolvedValue({ count: 1 });
      const mockIngestionUpsert = vi.fn().mockResolvedValue({});

      const mockTx = {
        contract: { upsert: mockContractUpsert },
        event: { createMany: mockEventCreateMany },
        ingestionState: { upsert: mockIngestionUpsert },
      };

      const mockPrisma = {
        $transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockTx)),
      } as any;

      const manager = new CursorManager(mockPrisma);

      const sampleEvents: DecodedSorobanEvent[] = [
        {
          id: '005000-0-0',
          contractId: 'C_USDC_1',
          type: 'contract',
          ledger: 5000n,
          ledgerClosedAt: new Date('2026-10-24T00:00:00Z'),
          txHash: 'txhash123',
          topics: ['transfer', 1000000n],
          data: { amount: 500n },
          rawXdr: 'raw_base64_xdr',
        },
      ];

      await manager.saveEventsAndCursor('C_USDC_1', sampleEvents, '005000-0-0', 5000n);

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);

      // Verify contract upsert called for foreign key integrity
      expect(mockContractUpsert).toHaveBeenCalledWith({
        where: { id: 'C_USDC_1' },
        update: {},
        create: {
          id: 'C_USDC_1',
          name: 'C_USDC_1',
          network: 'TESTNET',
          active: true,
        },
      });

      // Verify createMany called with skipDuplicates: true
      expect(mockEventCreateMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            id: '005000-0-0',
            contractId: 'C_USDC_1',
            type: 'contract',
            ledger: 5000n,
            txHash: 'txhash123',
            topics: ['transfer', '1000000'],
            data: { amount: '500' },
          }),
        ],
        skipDuplicates: true,
      });

      // Verify cursor upsert called
      expect(mockIngestionUpsert).toHaveBeenCalledWith({
        where: { contractId: 'C_USDC_1' },
        update: expect.objectContaining({
          cursor: '005000-0-0',
          lastLedgerSequence: 5000n,
        }),
        create: expect.objectContaining({
          contractId: 'C_USDC_1',
          cursor: '005000-0-0',
          lastLedgerSequence: 5000n,
        }),
      });
    });
  });
});
