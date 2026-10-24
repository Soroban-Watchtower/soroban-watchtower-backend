import { config } from '../config/env.js';
import { prisma } from '../db/client.js';
import { decodeSorobanEvent } from '../decoder/eventDecoder.js';
import { CursorManager, createCursorManager } from './cursorManager.js';
import { SorobanRpcClient, createRpcClient } from './rpcClient.js';
import { DecodedSorobanEvent } from '../types/index.js';

// Default known Stellar Testnet USDC / SAC contract
export const DEFAULT_TESTNET_USDC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

export interface PollerOptions {
  contractIds?: string[];
  pollIntervalMs?: number;
  batchSize?: number;
  startLedgerOffset?: number;
  rpcClient?: SorobanRpcClient;
  cursorManager?: CursorManager;
  onEventsPersisted?: (contractId: string, events: DecodedSorobanEvent[]) => Promise<void> | void;
}

export interface PollResult {
  contractId: string;
  eventsFetched: number;
  newCursor: string | null;
  lastLedger: bigint;
  hasMore: boolean;
}

/**
 * Continuous ingestion poller for Soroban smart contract events.
 * Implements cursor pagination, event decoding, atomic persistence, and backlog fast-forwarding.
 */
export class IngestionPoller {
  private readonly rpcClient: SorobanRpcClient;
  private readonly cursorManager: CursorManager;
  private readonly contractIds: string[];
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly startLedgerOffset: number;
  private readonly onEventsPersisted?: (
    contractId: string,
    events: DecodedSorobanEvent[]
  ) => Promise<void> | void;

  private isRunning: boolean = false;
  private abortController: AbortController | null = null;

  constructor(options: PollerOptions = {}) {
    this.rpcClient = options.rpcClient || createRpcClient();
    this.cursorManager = options.cursorManager || createCursorManager();
    this.contractIds =
      options.contractIds && options.contractIds.length > 0
        ? options.contractIds
        : [process.env.MONITOR_CONTRACT_ID || DEFAULT_TESTNET_USDC];
    this.pollIntervalMs = options.pollIntervalMs ?? config.POLL_INTERVAL_MS;
    this.batchSize = options.batchSize ?? config.MAX_EVENTS_PER_BATCH;
    this.startLedgerOffset = options.startLedgerOffset ?? 100;
    this.onEventsPersisted = options.onEventsPersisted;
  }

  /**
   * Performs a single atomic poll step for a specific contract.
   *
   * 1. Reads last recorded cursor from database.
   * 2. If cursor exists, requests events from cursor (startLedger omitted).
   *    If no cursor exists, calculates startLedger = latestLedger - startLedgerOffset.
   * 3. Decodes each raw event through decodeSorobanEvent.
   * 4. Atomically persists events and updates cursor in database.
   * 5. Returns PollResult indicating if full page was returned (hasMore = true).
   */
  public async pollContract(contractId: string): Promise<PollResult> {
    const cursorState = await this.cursorManager.getCursor(contractId);

    let getEventsParams: Parameters<SorobanRpcClient['getEvents']>[0];

    if (cursorState?.cursor) {
      getEventsParams = {
        cursor: cursorState.cursor,
        filters: [{ type: 'contract', contractIds: [contractId] }],
        limit: this.batchSize,
      };
    } else {
      const latestLedgerInfo = await this.rpcClient.getLatestLedger();
      const startLedger = Math.max(1, latestLedgerInfo.sequence - this.startLedgerOffset);

      getEventsParams = {
        startLedger,
        filters: [{ type: 'contract', contractIds: [contractId] }],
        limit: this.batchSize,
      };
    }

    const rpcResponse = await this.rpcClient.getEvents(getEventsParams);
    const rawEvents = rpcResponse.events || [];

    // Decode all events into strongly-typed domain model
    const decodedEvents = rawEvents.map((rawEvt) =>
      decodeSorobanEvent(rawEvt as any, { contractId })
    );

    let newCursor = cursorState?.cursor ?? null;
    let lastLedger = BigInt(rpcResponse.latestLedger || 0);

    if (decodedEvents.length > 0) {
      const lastRawEvent = rawEvents[rawEvents.length - 1];
      newCursor = lastRawEvent.id;
      if (lastRawEvent.ledger) {
        lastLedger = BigInt(lastRawEvent.ledger);
      }

      await this.cursorManager.saveEventsAndCursor(
        contractId,
        decodedEvents,
        newCursor,
        lastLedger
      );

      if (this.onEventsPersisted) {
        try {
          await this.onEventsPersisted(contractId, decodedEvents);
        } catch (hookErr: any) {
          console.error(`[IngestionPoller] Error in onEventsPersisted hook: ${hookErr.message}`);
        }
      }
    } else {
      // Advance last ledger sequence even when no new events match the filter
      await this.cursorManager.updateCursorOnly(contractId, newCursor, lastLedger);
    }

    const hasMore = rawEvents.length >= this.batchSize;

    return {
      contractId,
      eventsFetched: decodedEvents.length,
      newCursor,
      lastLedger,
      hasMore,
    };
  }

  /**
   * Starts continuous polling loop across all configured contracts.
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.abortController = new AbortController();

    console.log(
      `[IngestionPoller] Worker started. Monitoring ${this.contractIds.length} contract(s): ${this.contractIds.join(', ')}`
    );

    while (this.isRunning) {
      let anyContractHadMore = false;

      for (const contractId of this.contractIds) {
        if (!this.isRunning) break;

        try {
          const result = await this.pollContract(contractId);
          if (result.eventsFetched > 0) {
            console.log(
              `[IngestionPoller] Contract ${contractId}: ingested ${result.eventsFetched} event(s). Latest cursor: ${result.newCursor}`
            );
          }

          if (result.hasMore) {
            anyContractHadMore = true;
          }
        } catch (error: any) {
          console.error(
            `[IngestionPoller] Error polling contract ${contractId}: ${error.message}`
          );
        }
      }

      // If any contract returned a full page of events, fast-forward immediately without sleeping
      if (anyContractHadMore) {
        continue;
      }

      // Otherwise wait for the next ledger close interval
      await this.sleep(this.pollIntervalMs);
    }

    console.log('[IngestionPoller] Poller stopped gracefully.');
  }

  /**
   * Gracefully stops the polling loop.
   */
  public stop(): void {
    this.isRunning = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Factory helper to instantiate IngestionPoller.
 */
export function createPoller(options?: PollerOptions): IngestionPoller {
  return new IngestionPoller(options);
}

// Auto-run if executed directly via CLI (npm run dev:ingest or tsx src/ingest/poller.ts)
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').includes('src/ingest/poller')) {
  const poller = createPoller();

  const shutdown = () => {
    console.log('\n[IngestionPoller] Received termination signal. Shutting down...');
    poller.stop();
    prisma.$disconnect().then(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  poller.start().catch((err) => {
    console.error('[IngestionPoller] Fatal error:', err);
    process.exit(1);
  });
}
