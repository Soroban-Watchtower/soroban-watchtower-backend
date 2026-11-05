import { config } from '../config/env.js';
import { prisma as defaultPrisma } from '../db/client.js';
import { decodeSorobanEvent } from '../decoder/eventDecoder.js';
import { CursorManager, createCursorManager } from './cursorManager.js';
import { SorobanRpcClient, createRpcClient } from './rpcClient.js';
import { FailedEventManager, createFailedEventManager } from './failedEventManager.js';
import { contractEvents, ContractEventData } from './contractEvents.js';
import { DecodedSorobanEvent } from '../types/index.js';
import {
  pollerLagLedgers,
  pollerChainLedger,
  pollerLastLedger,
  pollerTicksTotal,
  pollerBatchesTotal,
  pollerMonitoredContracts,
  pollerTickDuration,
  eventsIngestedTotal,
} from '../observability/metrics.js';

// Default known Stellar Testnet USDC / SAC contract
export const DEFAULT_TESTNET_USDC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

// Soroban RPC specification limit: max 5 contract IDs per getEvents filter
export const MAX_SOROBAN_BATCH_CHUNK = 5;

export interface PollerOptions {
  contractIds?: string[];
  pollIntervalMs?: number;
  batchSize?: number;
  startLedgerOffset?: number;
  batchChunkSize?: number; // max contracts per RPC request (default: 5, ceiling: 5)
  shardCount?: number; // number of concurrent worker shards (default: 2)
  dynamicSync?: boolean; // enable dynamic DB contract sync and live event listeners (default: true)
  dbSyncIntervalMs?: number; // interval for periodic DB sync (default: 15000ms)
  highVolumeContractIds?: string[]; // contracts that receive dedicated worker shards
  rpcClient?: SorobanRpcClient;
  cursorManager?: CursorManager;
  failedEventManager?: FailedEventManager;
  prismaClient?: typeof defaultPrisma;
  onEventsPersisted?: (contractId: string, events: DecodedSorobanEvent[]) => Promise<void> | void;
}

export interface PollResult {
  contractId: string;
  eventsFetched: number;
  newCursor: string | null;
  lastLedger: bigint;
  chainLedger: bigint;
  lag: bigint;
  hasMore: boolean;
}

export interface BatchPollResult {
  contractIds: string[];
  totalEventsFetched: number;
  resultsByContract: Map<string, PollResult>;
  chainLedger: bigint;
  hasMore: boolean;
}

export interface IngestionShard {
  id: number;
  name: string;
  contractIds: Set<string>;
  isDedicated: boolean;
}

/**
 * Continuous, high-performance ingestion poller for Soroban smart contract events.
 *
 * Architectural Capabilities:
 * 1. RPC Multi-Contract Batch Chunking: Batches up to 5 contracts per `getEvents` call,
 *    reducing network RPC round-trips by up to 80%.
 * 2. Concurrent Worker Sharding: Distributes monitored contracts across independent shard
 *    loops, isolating high-volume contracts to prevent head-of-line blocking.
 * 3. Dynamic Database & Event Synchronization: Subscribes to contract lifecycle events and
 *    periodically synchronizes active contracts from PostgreSQL without server restarts.
 * 4. Idempotent Cursor Progression: Persists cursors and events inside interactive PostgreSQL
 *    transactions with deduplication and dead-letter quarantine.
 */
export class IngestionPoller {
  private readonly rpcClient: SorobanRpcClient;
  private readonly cursorManager: CursorManager;
  private readonly failedEventManager: FailedEventManager;
  private readonly prisma: typeof defaultPrisma;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly startLedgerOffset: number;
  private readonly batchChunkSize: number;
  private readonly shardCount: number;
  private readonly dynamicSync: boolean;
  private readonly dbSyncIntervalMs: number;
  private readonly highVolumeContractIds: Set<string>;
  private readonly onEventsPersisted?: (
    contractId: string,
    events: DecodedSorobanEvent[]
  ) => Promise<void> | void;

  // Active state
  private readonly monitoredContracts: Set<string> = new Set();
  private readonly shards: Map<number, IngestionShard> = new Map();
  private isRunning: boolean = false;
  private abortController: AbortController | null = null;
  private dbSyncTimer: NodeJS.Timeout | null = null;
  private shardPromises: Promise<void>[] = [];

  // Bound event listeners for cleanup
  private boundContractRegistered = (data: ContractEventData) => this.handleContractRegistered(data);
  private boundContractUpdated = (data: ContractEventData) => this.handleContractUpdated(data);
  private boundContractDeleted = (data: { id: string }) => this.handleContractDeleted(data);

  constructor(options: PollerOptions = {}) {
    this.rpcClient = options.rpcClient || createRpcClient();
    this.cursorManager = options.cursorManager || createCursorManager();
    this.failedEventManager = options.failedEventManager || createFailedEventManager();
    this.prisma = options.prismaClient || defaultPrisma;

    this.pollIntervalMs = options.pollIntervalMs ?? config.POLL_INTERVAL_MS;
    this.batchSize = options.batchSize ?? config.MAX_EVENTS_PER_BATCH;
    this.startLedgerOffset = options.startLedgerOffset ?? 100;
    this.batchChunkSize = Math.min(
      MAX_SOROBAN_BATCH_CHUNK,
      Math.max(1, options.batchChunkSize ?? MAX_SOROBAN_BATCH_CHUNK)
    );
    this.shardCount = Math.max(1, options.shardCount ?? 2);
    this.dynamicSync = options.dynamicSync ?? true;
    this.dbSyncIntervalMs = options.dbSyncIntervalMs ?? 15000;
    this.highVolumeContractIds = new Set(options.highVolumeContractIds || []);
    this.onEventsPersisted = options.onEventsPersisted;

    // Seed initial monitored contracts
    const initialContracts =
      options.contractIds && options.contractIds.length > 0
        ? options.contractIds
        : [process.env.MONITOR_CONTRACT_ID || DEFAULT_TESTNET_USDC];

    for (const cId of initialContracts) {
      if (cId) this.monitoredContracts.add(cId);
    }

    this.initializeShards();
    this.setupEventListeners();
    pollerMonitoredContracts.set(this.monitoredContracts.size);
  }

  /**
   * Initializes standard and dedicated shards, partitioning seeded contracts across them.
   */
  private initializeShards(): void {
    this.shards.clear();

    // Standard partitioned shards
    for (let i = 0; i < this.shardCount; i++) {
      this.shards.set(i, {
        id: i,
        name: `Shard-${i}`,
        contractIds: new Set<string>(),
        isDedicated: false,
      });
    }

    // Assign initial contracts to shards
    for (const contractId of this.monitoredContracts) {
      this.assignContractToShard(contractId);
    }
  }

  /**
   * Assigns a contract to either a dedicated high-volume shard or a standard partitioned shard.
   */
  private assignContractToShard(contractId: string): void {
    if (this.highVolumeContractIds.has(contractId)) {
      // Dedicated shard for high-volume contract
      const dedicatedShardId = 1000 + this.shards.size;
      const dedicatedShard: IngestionShard = {
        id: dedicatedShardId,
        name: `HV-${contractId.slice(0, 6)}`,
        contractIds: new Set([contractId]),
        isDedicated: true,
      };
      this.shards.set(dedicatedShardId, dedicatedShard);
    } else {
      // Partition hash across standard shards
      const shardIndex = this.getShardIndexForContract(contractId);
      const shard = this.shards.get(shardIndex);
      if (shard) {
        shard.contractIds.add(contractId);
      }
    }
  }

  /**
   * Deterministic partition hash for a contract address.
   */
  private getShardIndexForContract(contractId: string): number {
    let hash = 0;
    for (let i = 0; i < contractId.length; i++) {
      hash = (hash << 5) - hash + contractId.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash) % this.shardCount;
  }

  /**
   * Attaches real-time contract lifecycle event listeners.
   */
  private setupEventListeners(): void {
    if (!this.dynamicSync) return;
    contractEvents.on('contract:registered', this.boundContractRegistered);
    contractEvents.on('contract:updated', this.boundContractUpdated);
    contractEvents.on('contract:deleted', this.boundContractDeleted);
  }

  private handleContractRegistered(data: ContractEventData): void {
    if (data.id && data.active !== false) {
      this.addContract(data.id);
    }
  }

  private handleContractUpdated(data: ContractEventData): void {
    if (!data.id) return;
    if (data.active === false) {
      this.removeContract(data.id);
    } else if (data.active === true) {
      this.addContract(data.id);
    }
  }

  private handleContractDeleted(data: { id: string }): void {
    if (data.id) {
      this.removeContract(data.id);
    }
  }

  /**
   * Dynamically adds a contract to monitoring and assigns it to an active shard.
   */
  public addContract(contractId: string, isHighVolume: boolean = false): void {
    if (isHighVolume) {
      this.highVolumeContractIds.add(contractId);
    }
    this.monitoredContracts.add(contractId);
    this.assignContractToShard(contractId);
    pollerMonitoredContracts.set(this.monitoredContracts.size);
    console.log(
      `[IngestionPoller] Dynamically registered contract: ${contractId} (Total active: ${this.monitoredContracts.size})`
    );
  }

  /**
   * Dynamically removes a contract from monitoring across all shards.
   */
  public removeContract(contractId: string): void {
    this.monitoredContracts.delete(contractId);
    this.highVolumeContractIds.delete(contractId);

    for (const [shardId, shard] of this.shards.entries()) {
      shard.contractIds.delete(contractId);
      if (shard.isDedicated && shard.contractIds.size === 0) {
        this.shards.delete(shardId);
      }
    }

    pollerMonitoredContracts.set(this.monitoredContracts.size);
    console.log(
      `[IngestionPoller] Dynamically removed contract: ${contractId} (Total active: ${this.monitoredContracts.size})`
    );
  }

  /**
   * Returns a snapshot of all contract IDs actively monitored.
   */
  public getMonitoredContracts(): string[] {
    return Array.from(this.monitoredContracts);
  }

  /**
   * Returns a snapshot of active ingestion shards and their assigned contracts.
   */
  public getShards(): IngestionShard[] {
    return Array.from(this.shards.values());
  }

  /**
   * Synchronizes active contracts from PostgreSQL.
   * Discovers newly added contracts and cleans up deactivated contracts without server restart.
   */
  public async syncContractsFromDb(): Promise<string[]> {
    try {
      if (!this.prisma?.contract) {
        return Array.from(this.monitoredContracts);
      }

      const activeRecords = await this.prisma.contract.findMany({
        where: { active: true },
        select: { id: true },
      });

      const activeDbIds = new Set(activeRecords.map((r) => r.id));

      // Add any new contracts found in DB
      for (const dbId of activeDbIds) {
        if (!this.monitoredContracts.has(dbId)) {
          this.addContract(dbId);
        }
      }

      // Remove any contracts deactivated or removed from DB (if not initial overrides)
      for (const currentId of this.monitoredContracts) {
        if (!activeDbIds.has(currentId) && activeDbIds.size > 0) {
          this.removeContract(currentId);
        }
      }

      return Array.from(this.monitoredContracts);
    } catch (err: any) {
      console.error(`[IngestionPoller] Error syncing contracts from database: ${err.message}`);
      return Array.from(this.monitoredContracts);
    }
  }

  /**
   * Performs an atomic poll for a single contract.
   * Maintained for 100% backward compatibility and standalone tests.
   */
  public async pollContract(contractId: string): Promise<PollResult> {
    const startTime = performance.now();
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
    const chainLedger = BigInt(rpcResponse.latestLedger || 0);

    // Decode events into strongly-typed domain model, quarantining malformed events
    const decodedEvents: DecodedSorobanEvent[] = [];
    for (const rawEvt of rawEvents) {
      try {
        const decoded = decodeSorobanEvent(rawEvt as any, { contractId });
        decodedEvents.push(decoded);
        eventsIngestedTotal.inc({ contract_id: contractId, event_type: decoded.type });
      } catch (decodeErr: any) {
        await this.failedEventManager.recordFailedEvent({
          contractId,
          eventId: (rawEvt as any)?.id,
          eventType: 'unknown',
          rawPayload: rawEvt,
          error: decodeErr,
        });
      }
    }

    let newCursor = cursorState?.cursor ?? null;
    let lastLedger = chainLedger;

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
        lastLedger,
        chainLedger,
        newCursor
      );

      if (this.onEventsPersisted) {
        try {
          await this.onEventsPersisted(contractId, decodedEvents);
        } catch (hookErr: any) {
          console.error(`[IngestionPoller] Error in onEventsPersisted hook: ${hookErr.message}`);
        }
      }
    } else {
      await this.cursorManager.updateCursorOnly(contractId, newCursor, lastLedger, chainLedger);
    }

    const lag = chainLedger > lastLedger ? chainLedger - lastLedger : 0n;

    pollerChainLedger.set(Number(chainLedger), { network: 'TESTNET' });
    pollerLastLedger.set(Number(lastLedger), { contract_id: contractId });
    pollerLagLedgers.set(Number(lag), { contract_id: contractId });
    pollerTicksTotal.inc({ status: decodedEvents.length > 0 ? 'success' : 'empty' });

    const durationSeconds = (performance.now() - startTime) / 1000;
    pollerTickDuration.observe(durationSeconds);

    const hasMore = rawEvents.length >= this.batchSize;

    return {
      contractId,
      eventsFetched: decodedEvents.length,
      newCursor,
      lastLedger,
      chainLedger,
      lag,
      hasMore,
    };
  }

  /**
   * Performs an atomic multi-contract batch poll for up to 5 contract IDs in a single RPC query.
   *
   * 1. Retrieves cursor states across all contracts in the chunk.
   * 2. Evaluates the earliest ledger position needed across the batch.
   * 3. Dispatches a single `getEvents` RPC request with `contractIds: chunk`.
   * 4. Demultiplexes returned events by `contractId`, decodes XDR payloads, and persists atomically.
   * 5. Advances cursors and Prometheus lag metrics for all contracts in the chunk.
   */
  public async pollBatch(contractBatch: string[]): Promise<BatchPollResult> {
    const startTime = performance.now();

    if (contractBatch.length === 0) {
      return {
        contractIds: [],
        totalEventsFetched: 0,
        resultsByContract: new Map(),
        chainLedger: 0n,
        hasMore: false,
      };
    }

    // Single-contract optimization: delegate directly to pollContract
    if (contractBatch.length === 1) {
      const singleResult = await this.pollContract(contractBatch[0]);
      return {
        contractIds: contractBatch,
        totalEventsFetched: singleResult.eventsFetched,
        resultsByContract: new Map([[contractBatch[0], singleResult]]),
        chainLedger: singleResult.chainLedger,
        hasMore: singleResult.hasMore,
      };
    }

    // Enforce Soroban RPC limit of max 5 contracts per filter
    const chunk = contractBatch.slice(0, MAX_SOROBAN_BATCH_CHUNK);

    // Retrieve cursor states across all contracts in the batch in parallel
    const cursorStates = await Promise.all(
      chunk.map(async (cId) => ({
        contractId: cId,
        state: await this.cursorManager.getCursor(cId),
      }))
    );

    // Determine query strategy: cursor vs startLedger
    // If all contracts share the exact same cursor, we can use it directly
    const firstCursor = cursorStates[0].state?.cursor;
    const allShareSameCursor =
      firstCursor &&
      cursorStates.every((cs) => cs.state?.cursor && cs.state.cursor === firstCursor);

    let getEventsParams: Parameters<SorobanRpcClient['getEvents']>[0];

    if (allShareSameCursor) {
      getEventsParams = {
        cursor: firstCursor,
        filters: [{ type: 'contract', contractIds: chunk }],
        limit: this.batchSize,
      };
    } else {
      // Find minimum ledger sequence among contracts that have cursors
      let minLedger: bigint | null = null;
      let hasUninitializedContract = false;

      for (const cs of cursorStates) {
        if (cs.state && cs.state.lastLedgerSequence > 0n) {
          if (minLedger === null || cs.state.lastLedgerSequence < minLedger) {
            minLedger = cs.state.lastLedgerSequence;
          }
        } else {
          hasUninitializedContract = true;
        }
      }

      if (hasUninitializedContract || minLedger === null) {
        const latestLedgerInfo = await this.rpcClient.getLatestLedger();
        const defaultStart = BigInt(Math.max(1, latestLedgerInfo.sequence - this.startLedgerOffset));
        minLedger = minLedger !== null && minLedger < defaultStart ? minLedger : defaultStart;
      }

      getEventsParams = {
        startLedger: Number(minLedger),
        filters: [{ type: 'contract', contractIds: chunk }],
        limit: this.batchSize,
      };
    }

    const rpcResponse = await this.rpcClient.getEvents(getEventsParams);
    const rawEvents = rpcResponse.events || [];
    const chainLedger = BigInt(rpcResponse.latestLedger || 0);

    // Group raw events by contract ID
    const rawEventsByContract = new Map<string, any[]>();
    for (const cId of chunk) {
      rawEventsByContract.set(cId, []);
    }

    for (const rawEvt of rawEvents) {
      const cId = (rawEvt as any).contractId;
      if (cId && rawEventsByContract.has(cId)) {
        rawEventsByContract.get(cId)!.push(rawEvt);
      }
    }

    const resultsByContract = new Map<string, PollResult>();
    let totalEventsFetched = 0;

    // Process and persist events per contract
    for (const cs of cursorStates) {
      const cId = cs.contractId;
      const rawEventsForContract = rawEventsByContract.get(cId) || [];
      const decodedEvents: DecodedSorobanEvent[] = [];

      for (const rawEvt of rawEventsForContract) {
        try {
          const decoded = decodeSorobanEvent(rawEvt, { contractId: cId });
          decodedEvents.push(decoded);
          eventsIngestedTotal.inc({ contract_id: cId, event_type: decoded.type });
        } catch (decodeErr: any) {
          await this.failedEventManager.recordFailedEvent({
            contractId: cId,
            eventId: (rawEvt as any)?.id,
            eventType: 'unknown',
            rawPayload: rawEvt,
            error: decodeErr,
          });
        }
      }

      totalEventsFetched += decodedEvents.length;
      let newCursor = cs.state?.cursor ?? null;
      let lastLedger = chainLedger;

      if (decodedEvents.length > 0) {
        const lastRawEvent = rawEventsForContract[rawEventsForContract.length - 1];
        newCursor = lastRawEvent.id;
        if (lastRawEvent.ledger) {
          lastLedger = BigInt(lastRawEvent.ledger);
        }

        await this.cursorManager.saveEventsAndCursor(
          cId,
          decodedEvents,
          newCursor,
          lastLedger,
          chainLedger,
          newCursor
        );

        if (this.onEventsPersisted) {
          try {
            await this.onEventsPersisted(cId, decodedEvents);
          } catch (hookErr: any) {
            console.error(`[IngestionPoller] Error in onEventsPersisted for ${cId}: ${hookErr.message}`);
          }
        }
      } else {
        // Advance ledger progression when no new events arrived
        await this.cursorManager.updateCursorOnly(cId, newCursor, lastLedger, chainLedger);
      }

      const lag = chainLedger > lastLedger ? chainLedger - lastLedger : 0n;

      pollerLastLedger.set(Number(lastLedger), { contract_id: cId });
      pollerLagLedgers.set(Number(lag), { contract_id: cId });

      resultsByContract.set(cId, {
        contractId: cId,
        eventsFetched: decodedEvents.length,
        newCursor,
        lastLedger,
        chainLedger,
        lag,
        hasMore: rawEvents.length >= this.batchSize,
      });
    }

    const hasMore = rawEvents.length >= this.batchSize;

    pollerChainLedger.set(Number(chainLedger), { network: 'TESTNET' });
    pollerBatchesTotal.inc({ shard_id: 'batch', status: rawEvents.length > 0 ? 'success' : 'empty' });
    pollerTicksTotal.inc({ status: rawEvents.length > 0 ? 'success' : 'empty' });

    const durationSeconds = (performance.now() - startTime) / 1000;
    pollerTickDuration.observe(durationSeconds);

    return {
      contractIds: chunk,
      totalEventsFetched,
      resultsByContract,
      chainLedger,
      hasMore,
    };
  }

  /**
   * Polling loop for a single shard. Runs concurrently with other shards.
   */
  private async runShardLoop(shard: IngestionShard): Promise<void> {
    while (this.isRunning) {
      if (shard.contractIds.size === 0) {
        await this.sleep(this.pollIntervalMs);
        continue;
      }

      const contracts = Array.from(shard.contractIds);
      const batches = this.chunkArray(contracts, this.batchChunkSize);
      let anyBatchHadMore = false;

      for (const batch of batches) {
        if (!this.isRunning) break;

        try {
          const batchResult = await this.pollBatch(batch);
          if (batchResult.totalEventsFetched > 0) {
            console.log(
              `[IngestionPoller][${shard.name}] Ingested ${batchResult.totalEventsFetched} event(s) across batch [${batch.join(', ')}]`
            );
          }

          if (batchResult.hasMore) {
            anyBatchHadMore = true;
          }
        } catch (error: any) {
          console.error(
            `[IngestionPoller][${shard.name}] Error polling batch [${batch.join(', ')}]: ${error.message}`
          );
        }
      }

      // If any batch returned a full page of events, fast-forward this shard immediately without sleeping
      if (anyBatchHadMore) {
        continue;
      }

      await this.sleep(this.pollIntervalMs);
    }
  }

  /**
   * Starts concurrent multi-shard polling across all configured contracts.
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.abortController = new AbortController();

    // Perform initial dynamic sync from database if enabled
    if (this.dynamicSync) {
      await this.syncContractsFromDb();

      this.dbSyncTimer = setInterval(() => {
        if (this.isRunning) {
          this.syncContractsFromDb().catch((err) => {
            console.error('[IngestionPoller] Background DB contract sync failed:', err);
          });
        }
      }, this.dbSyncIntervalMs);

      if (this.dbSyncTimer.unref) {
        this.dbSyncTimer.unref();
      }
    }

    console.log(
      `[IngestionPoller] Engine started. Monitoring ${this.monitoredContracts.size} contract(s) across ${this.shards.size} shard(s) (Batch chunk: ${this.batchChunkSize})`
    );

    // Launch independent concurrent polling loops for each shard
    this.shardPromises = [];
    for (const shard of this.shards.values()) {
      const promise = this.runShardLoop(shard).catch((err) => {
        console.error(`[IngestionPoller] Fatal error in ${shard.name}:`, err);
      });
      this.shardPromises.push(promise);
    }
  }

  /**
   * Gracefully stops all polling shards and periodic database sync timers.
   */
  public stop(): void {
    this.isRunning = false;

    if (this.dbSyncTimer) {
      clearInterval(this.dbSyncTimer);
      this.dbSyncTimer = null;
    }

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    contractEvents.removeListener('contract:registered', this.boundContractRegistered);
    contractEvents.removeListener('contract:updated', this.boundContractUpdated);
    contractEvents.removeListener('contract:deleted', this.boundContractDeleted);

    console.log('[IngestionPoller] Poller stopped gracefully.');
  }

  /**
   * Utility helper to partition an array into chunks of specified size.
   */
  private chunkArray<T>(items: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += chunkSize) {
      chunks.push(items.slice(i, i + chunkSize));
    }
    return chunks;
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
    defaultPrisma.$disconnect().then(() => {
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
