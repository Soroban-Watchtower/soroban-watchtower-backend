/**
 * Pure deterministic domain math and in-memory aggregation for Soroban Watchdog.
 * Computes telemetry velocity, outflow ratios, and frequency metrics with zero chain round-trips.
 */

export interface VolumeVelocityResult {
  totalVolume: bigint;
  eventCount: number;
  velocityPerSecond: number;
  averageAmountPerEvent: bigint;
}

export interface FrequencyAnalysisResult {
  totalEvents: number;
  windowSeconds: number;
  eventsPerMinute: number;
  eventsPerSecond: number;
  burstCountMax: number;
}

export interface ContractTelemetrySummary {
  contractId: string;
  totalEvents: number;
  totalVolume: string;
  velocityPerSecond: number;
  eventsPerMinute: number;
  lagLedgers: number;
  isHealthy: boolean;
  computedAt: string;
}

/**
 * Computes aggregate volume and transfer velocity over a sliding time window.
 */
export function calculateVolumeVelocity(
  items: Array<{ amount: bigint | string | number }>,
  windowSeconds: number
): VolumeVelocityResult {
  if (items.length === 0 || windowSeconds <= 0) {
    return {
      totalVolume: 0n,
      eventCount: 0,
      velocityPerSecond: 0,
      averageAmountPerEvent: 0n,
    };
  }

  let totalVolume = 0n;
  for (const item of items) {
    try {
      totalVolume += BigInt(item.amount);
    } catch {
      // ignore non-convertible amounts
    }
  }

  const averageAmountPerEvent = totalVolume / BigInt(items.length);
  // Velocity in base units per second (converted to floating point number safely)
  const velocityPerSecond = Number(totalVolume) / windowSeconds;

  return {
    totalVolume,
    eventCount: items.length,
    velocityPerSecond,
    averageAmountPerEvent,
  };
}

/**
 * Computes the ratio of capital outflow against an asset reserve or baseline.
 * Returns percentage (0.00 to 100.00).
 */
export function calculateOutflowRatio(outflow: bigint, baseline: bigint): number {
  if (baseline <= 0n || outflow <= 0n) {
    return 0;
  }
  // Compute with 4 decimal places of precision using integer arithmetic
  const basisPoints = (outflow * 10000n) / baseline;
  return Number(basisPoints) / 100;
}

/**
 * Calculates event emission frequency, rate, and peak burst within a sliding window.
 */
export function calculateFrequency(
  timestamps: Date[],
  windowSeconds: number
): FrequencyAnalysisResult {
  if (timestamps.length === 0 || windowSeconds <= 0) {
    return {
      totalEvents: 0,
      windowSeconds,
      eventsPerMinute: 0,
      eventsPerSecond: 0,
      burstCountMax: 0,
    };
  }

  const eventsPerSecond = timestamps.length / windowSeconds;
  const eventsPerMinute = eventsPerSecond * 60;

  // Calculate maximum events in any single second bucket (burst detection)
  const secondBuckets = new Map<number, number>();
  for (const ts of timestamps) {
    const sec = Math.floor(ts.getTime() / 1000);
    secondBuckets.set(sec, (secondBuckets.get(sec) || 0) + 1);
  }

  let burstCountMax = 0;
  for (const count of secondBuckets.values()) {
    if (count > burstCountMax) {
      burstCountMax = count;
    }
  }

  return {
    totalEvents: timestamps.length,
    windowSeconds,
    eventsPerMinute,
    eventsPerSecond,
    burstCountMax,
  };
}

/**
 * Generates an in-memory telemetry summary for a contract without contacting the blockchain.
 */
export function summarizeTelemetry(
  contractId: string,
  events: Array<{ ledgerClosedAt: Date; data?: any }>,
  lagLedgers: bigint = 0n,
  windowSeconds: number = 300
): ContractTelemetrySummary {
  const timestamps = events.map((e) => e.ledgerClosedAt);
  const freq = calculateFrequency(timestamps, windowSeconds);

  // Extract amount values if present in event data
  const volumeItems: { amount: bigint }[] = [];
  for (const e of events) {
    const amountVal = e.data?.amount ?? e.data?.value;
    if (amountVal !== undefined && amountVal !== null) {
      try {
        volumeItems.push({ amount: BigInt(amountVal) });
      } catch {
        // skip
      }
    }
  }

  const vol = calculateVolumeVelocity(volumeItems, windowSeconds);

  return {
    contractId,
    totalEvents: events.length,
    totalVolume: vol.totalVolume.toString(),
    velocityPerSecond: vol.velocityPerSecond,
    eventsPerMinute: freq.eventsPerMinute,
    lagLedgers: Number(lagLedgers),
    isHealthy: lagLedgers <= 2n,
    computedAt: new Date().toISOString(),
  };
}
