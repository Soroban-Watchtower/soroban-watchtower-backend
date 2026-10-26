import { PrismaClient, IngestionState } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/client.js';
import { DecodedSorobanEvent } from '../types/index.js';

export interface CursorState {
  cursor: string | null;
  lastLedgerSequence: bigint;
  chainLedger?: bigint;
  lastEventId?: string | null;
  lag?: bigint;
}

export interface LagInfo {
  contractId: string;
  lastLedger: bigint;
  chainLedger: bigint;
  lag: bigint;
  isSynced: boolean;
}

export interface LedgerGapResult {
  gapDetected: boolean;
  oldestRpcLedger: bigint;
  currentCursorLedger: bigint;
  missingLedgersCount: bigint;
}

/**
 * Recursively converts JavaScript BigInts to string representations so they can be
 * safely serialized into Prisma PostgreSQL JSON / JSONB columns without throwing TypeErrors.
 */
export function serializeBigIntForJson(val: any): any {
  if (val === null || val === undefined) {
    return val;
  }
  if (typeof val === 'bigint') {
    return val.toString();
  }
  if (Array.isArray(val)) {
    return val.map(serializeBigIntForJson);
  }
  if (typeof val === 'object' && !(val instanceof Date)) {
    const serialized: Record<string, any> = {};
    for (const [key, propVal] of Object.entries(val)) {
      serialized[key] = serializeBigIntForJson(propVal);
    }
    return serialized;
  }
  return val;
}

/**
 * Manages database persistence for Soroban ingestion cursor state and event batching.
 * Guarantees atomic writes (events + cursor update in a single transaction) and deduplication.
 */
export class CursorManager {
  private readonly prisma: PrismaClient;

  constructor(prismaClient: PrismaClient = defaultPrisma) {
    this.prisma = prismaClient;
  }

  /**
   * Retrieves the current ingestion cursor and last ledger sequence for a given contract.
   * Returns null if the contract has never been ingested.
   */
  public async getCursor(contractId: string): Promise<CursorState | null> {
    const record = await this.prisma.ingestionState.findUnique({
      where: { contractId },
    });

    if (!record) {
      return null;
    }

    const chainLedger = record.chainLedger ?? 0n;
    const lastLedger = record.lastLedgerSequence ?? 0n;
    const lag = chainLedger > lastLedger ? chainLedger - lastLedger : 0n;

    return {
      cursor: record.cursor,
      lastLedgerSequence: lastLedger,
      chainLedger,
      lastEventId: record.lastEventId ?? null,
      lag,
    };
  }

  /**
   * Calculates the real-time ingestion lag between the upstream chain head and the contract's applied ledger.
   */
  public async getLag(contractId: string): Promise<LagInfo | null> {
    const state = await this.getCursor(contractId);
    if (!state) {
      return null;
    }
    const chainLedger = state.chainLedger ?? 0n;
    const lastLedger = state.lastLedgerSequence ?? 0n;
    const lag = chainLedger > lastLedger ? chainLedger - lastLedger : 0n;

    return {
      contractId,
      lastLedger,
      chainLedger,
      lag,
      isSynced: lag <= 1n,
    };
  }

  /**
   * Checks whether an ingestion gap occurred because Soroban RPC node history was pruned
   * beyond our last processed ledger sequence.
   */
  public checkLedgerGap(
    contractId: string,
    currentCursorLedger: bigint,
    oldestRpcLedger: bigint
  ): LedgerGapResult {
    if (currentCursorLedger > 0n && oldestRpcLedger > currentCursorLedger) {
      const missingCount = oldestRpcLedger - currentCursorLedger;
      return {
        gapDetected: true,
        oldestRpcLedger,
        currentCursorLedger,
        missingLedgersCount: missingCount,
      };
    }

    return {
      gapDetected: false,
      oldestRpcLedger,
      currentCursorLedger,
      missingLedgersCount: 0n,
    };
  }

  /**
   * Atomically saves a batch of decoded Soroban events and updates the contract's ingestion cursor.
   *
   * Invariants:
   * 1. Contract record is upserted to ensure foreign key integrity.
   * 2. Events are written using `createMany` with `skipDuplicates: true` to prevent duplicate failures.
   * 3. IngestionState is upserted with the new cursor, latest ledger sequence, chainLedger, and lastEventId.
   * 4. Executed inside a single Prisma interactive transaction.
   */
  public async saveEventsAndCursor(
    contractId: string,
    events: DecodedSorobanEvent[],
    cursor: string | null,
    lastLedgerSequence: bigint,
    chainLedger?: bigint,
    lastEventId?: string | null
  ): Promise<void> {
    const formattedEvents = events.map((event) => ({
      id: event.id,
      contractId: event.contractId || contractId,
      type: event.type,
      ledger: event.ledger,
      ledgerClosedAt: event.ledgerClosedAt,
      txHash: event.txHash,
      topics: serializeBigIntForJson(event.topics),
      data: serializeBigIntForJson(event.data),
      rawXdr: event.rawXdr,
    }));

    const resolvedLastEventId =
      lastEventId ?? (events.length > 0 ? events[events.length - 1].id : null);

    await this.prisma.$transaction(async (tx) => {
      // 1. Ensure the parent Contract entity exists so foreign key constraints pass
      await tx.contract.upsert({
        where: { id: contractId },
        update: {},
        create: {
          id: contractId,
          name: contractId,
          network: 'TESTNET',
          active: true,
        },
      });

      // 2. Insert events in batch with deduplication (skipDuplicates: true)
      if (formattedEvents.length > 0) {
        await tx.event.createMany({
          data: formattedEvents,
          skipDuplicates: true,
        });
      }

      // 3. Update the ingestion cursor state
      await tx.ingestionState.upsert({
        where: { contractId },
        update: {
          cursor,
          lastLedgerSequence,
          chainLedger: chainLedger ?? lastLedgerSequence,
          lastEventId: resolvedLastEventId,
          updatedAt: new Date(),
        },
        create: {
          contractId,
          cursor,
          lastLedgerSequence,
          chainLedger: chainLedger ?? lastLedgerSequence,
          lastEventId: resolvedLastEventId,
        },
      });
    });
  }

  /**
   * Updates only the cursor and lastLedgerSequence when a polling cycle yields zero new events.
   */
  public async updateCursorOnly(
    contractId: string,
    cursor: string | null,
    lastLedgerSequence: bigint,
    chainLedger?: bigint
  ): Promise<IngestionState> {
    return this.prisma.$transaction(async (tx) => {
      await tx.contract.upsert({
        where: { id: contractId },
        update: {},
        create: {
          id: contractId,
          name: contractId,
          network: 'TESTNET',
          active: true,
        },
      });

      return tx.ingestionState.upsert({
        where: { contractId },
        update: {
          cursor,
          lastLedgerSequence,
          chainLedger: chainLedger ?? lastLedgerSequence,
          updatedAt: new Date(),
        },
        create: {
          contractId,
          cursor,
          lastLedgerSequence,
          chainLedger: chainLedger ?? lastLedgerSequence,
        },
      });
    });
  }
}

/**
 * Factory helper to instantiate CursorManager.
 */
export function createCursorManager(prismaClient?: PrismaClient): CursorManager {
  return new CursorManager(prismaClient);
}
