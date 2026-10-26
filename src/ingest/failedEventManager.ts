import { PrismaClient, FailedEvent, FailedEventStatus } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/client.js';
import { failedEventsTotal } from '../observability/metrics.js';
import { logger } from '../observability/logger.js';

export interface RecordFailedEventOptions {
  contractId: string;
  eventId?: string;
  eventType?: string;
  rawPayload: any;
  error: Error | string;
}

export class FailedEventManager {
  private readonly prisma: PrismaClient;

  constructor(prismaClient: PrismaClient = defaultPrisma) {
    this.prisma = prismaClient;
  }

  /**
   * Quarantines an unparseable or rejected Soroban event into the dead-letter table.
   */
  async recordFailedEvent(options: RecordFailedEventOptions): Promise<FailedEvent> {
    const errorLog =
      options.error instanceof Error
        ? `${options.error.name}: ${options.error.message}\n${options.error.stack || ''}`
        : String(options.error);

    logger.warn(
      {
        contractId: options.contractId,
        eventId: options.eventId,
        error: options.error instanceof Error ? options.error.message : options.error,
      },
      '[FailedEventManager] Quarantining failed event to dead-letter storage'
    );

    failedEventsTotal.inc({
      contract_id: options.contractId,
      reason: options.error instanceof Error ? options.error.name : 'UnknownError',
    });

    // Ensure contract exists so foreign key is satisfied
    await this.prisma.contract.upsert({
      where: { id: options.contractId },
      update: {},
      create: {
        id: options.contractId,
        name: options.contractId,
        network: 'TESTNET',
        active: true,
      },
    });

    return this.prisma.failedEvent.create({
      data: {
        contractId: options.contractId,
        eventId: options.eventId,
        eventType: options.eventType || 'unknown',
        rawPayload: options.rawPayload ?? {},
        errorLog,
        status: 'PENDING',
        retryCount: 0,
      },
    });
  }

  /**
   * Retrieves pending failed events for replay.
   */
  async getPendingFailedEvents(limit: number = 100): Promise<FailedEvent[]> {
    return this.prisma.failedEvent.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }

  /**
   * Marks a failed event as successfully reprocessed and resolved.
   */
  async markResolved(id: string): Promise<FailedEvent> {
    return this.prisma.failedEvent.update({
      where: { id },
      data: {
        status: 'RESOLVED',
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Increments retry counter and records new error message on replay attempt.
   */
  async recordReplayFailure(id: string, error: Error | string): Promise<FailedEvent> {
    const errorStr = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return this.prisma.failedEvent.update({
      where: { id },
      data: {
        retryCount: { increment: 1 },
        errorLog: errorStr,
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Discards a failed event that cannot be repaired.
   */
  async markDiscarded(id: string): Promise<FailedEvent> {
    return this.prisma.failedEvent.update({
      where: { id },
      data: {
        status: 'DISCARDED',
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Prunes resolved or discarded dead-letter events older than a given retention threshold.
   */
  async prune(olderThanDays: number = 14): Promise<number> {
    const thresholdDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    const result = await this.prisma.failedEvent.deleteMany({
      where: {
        status: { in: ['RESOLVED', 'DISCARDED'] },
        updatedAt: { lt: thresholdDate },
      },
    });
    return result.count;
  }
}

export function createFailedEventManager(prismaClient?: PrismaClient): FailedEventManager {
  return new FailedEventManager(prismaClient);
}
