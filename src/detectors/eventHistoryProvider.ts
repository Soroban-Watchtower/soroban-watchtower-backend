import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/client.js';
import { DecodedSorobanEvent, EventHistoryProvider } from '../types/index.js';
import { parseSacEvent } from '../decoder/eventDecoder.js';

/**
 * Extracts a numeric volume/transfer amount from a decoded Soroban event.
 * Safely handles SEP-41 SAC standard payloads, custom token events, BigInts, and numbers.
 */
export function extractEventAmount(event: DecodedSorobanEvent): bigint | null {
  // 1. Try parsing via SEP-41 Stellar Asset Contract parser
  const sac = parseSacEvent(event);
  if (sac && sac.amount !== undefined) {
    return sac.amount;
  }

  // 2. Check topic symbols for transfer/outflow markers
  const isOutflowTopic = event.topics.some((topic) => {
    const s = String(topic).toLowerCase();
    return s === 'transfer' || s === 'withdraw' || s === 'burn' || s === 'outflow';
  });

  if (isOutflowTopic) {
    if (typeof event.data === 'bigint') {
      return event.data;
    }
    if (typeof event.data === 'number' || typeof event.data === 'string') {
      try {
        return BigInt(event.data);
      } catch {
        return null;
      }
    }
    if (event.data && typeof event.data === 'object') {
      const candidate = event.data.amount ?? event.data.value;
      if (candidate !== undefined) {
        try {
          return typeof candidate === 'bigint' ? candidate : BigInt(candidate);
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

/**
 * DatabaseEventHistoryProvider
 *
 * PostgreSQL-backed implementation of EventHistoryProvider.
 * Queries indexed historical event records within a sliding time window [now - windowSeconds, now].
 */
export class DatabaseEventHistoryProvider implements EventHistoryProvider {
  constructor(private readonly prisma: PrismaClient = defaultPrisma) {}

  async getEventsInWindow(
    contractId: string,
    windowSeconds: number
  ): Promise<DecodedSorobanEvent[]> {
    const windowStart = new Date(Date.now() - windowSeconds * 1000);

    const records = await this.prisma.event.findMany({
      where: {
        contractId,
        ledgerClosedAt: { gte: windowStart },
      },
      orderBy: { ledgerClosedAt: 'desc' },
    });

    return records.map((r) => ({
      id: r.id,
      contractId: r.contractId,
      type: r.type as 'contract' | 'system' | 'diagnostic',
      ledger: r.ledger,
      ledgerClosedAt: r.ledgerClosedAt,
      txHash: r.txHash,
      topics: Array.isArray(r.topics) ? (r.topics as (string | number | bigint)[]) : [],
      data: r.data,
      rawXdr: r.rawXdr,
    }));
  }

  async getAggregateVolume(
    contractId: string,
    windowSeconds: number,
    topic?: string
  ): Promise<bigint> {
    const events = await this.getEventsInWindow(contractId, windowSeconds);
    let total = 0n;

    for (const evt of events) {
      if (topic) {
        const matchesTopic = evt.topics.some(
          (t) => String(t).toLowerCase() === topic.toLowerCase()
        );
        if (!matchesTopic) continue;
      }

      const amount = extractEventAmount(evt);
      if (amount && amount > 0n) {
        total += amount;
      }
    }

    return total;
  }

  async getFailedEventCountInWindow(
    contractId: string,
    windowSeconds: number
  ): Promise<number> {
    const windowStart = new Date(Date.now() - windowSeconds * 1000);

    const count = await this.prisma.failedEvent.count({
      where: {
        contractId,
        createdAt: { gte: windowStart },
      },
    });

    return count;
  }
}

/**
 * InMemoryEventHistoryProvider
 *
 * High-performance, 0-dependency in-memory implementation of EventHistoryProvider.
 * Ideal for unit testing, integration simulations, and local testnet sandboxes.
 */
export class InMemoryEventHistoryProvider implements EventHistoryProvider {
  private events: DecodedSorobanEvent[] = [];
  private failedEventTimestamps = new Map<string, Date[]>();

  constructor(initialEvents: DecodedSorobanEvent[] = []) {
    this.events = [...initialEvents];
  }

  recordEvent(event: DecodedSorobanEvent): void {
    this.events.push(event);
  }

  recordFailedEvent(contractId: string, timestamp: Date = new Date()): void {
    const timestamps = this.failedEventTimestamps.get(contractId) || [];
    timestamps.push(timestamp);
    this.failedEventTimestamps.set(contractId, timestamps);
  }

  clear(): void {
    this.events = [];
    this.failedEventTimestamps.clear();
  }

  async getEventsInWindow(
    contractId: string,
    windowSeconds: number
  ): Promise<DecodedSorobanEvent[]> {
    const cutoff = new Date(Date.now() - windowSeconds * 1000);
    return this.events.filter(
      (e) => e.contractId === contractId && new Date(e.ledgerClosedAt) >= cutoff
    );
  }

  async getAggregateVolume(
    contractId: string,
    windowSeconds: number,
    topic?: string
  ): Promise<bigint> {
    const events = await this.getEventsInWindow(contractId, windowSeconds);
    let total = 0n;

    for (const evt of events) {
      if (topic) {
        const matchesTopic = evt.topics.some(
          (t) => String(t).toLowerCase() === topic.toLowerCase()
        );
        if (!matchesTopic) continue;
      }

      const amount = extractEventAmount(evt);
      if (amount && amount > 0n) {
        total += amount;
      }
    }

    return total;
  }

  async getFailedEventCountInWindow(
    contractId: string,
    windowSeconds: number
  ): Promise<number> {
    const cutoff = new Date(Date.now() - windowSeconds * 1000);
    const timestamps = this.failedEventTimestamps.get(contractId) || [];
    return timestamps.filter((t) => t >= cutoff).length;
  }
}

