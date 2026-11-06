import {
  DetectorPlugin,
  DetectorContext,
  DetectionResult,
  Severity,
} from '../types/index.js';
import { extractEventAmount } from './eventHistoryProvider.js';
import { calculateOutflowRatio } from '../lib/domainMath.js';

/**
 * RapidDrainDetector (Windowed Rule)
 *
 * Tracks cumulative capital outflow over a rolling time window (e.g., 5m, 15m, 1h).
 * Detects flash-loan drains, continuous siphoning, or rapid liquidity drops where
 * individual transactions might sit below single-transfer thresholds, but the
 * aggregate outflow poses a critical insolvency or exploit threat.
 */
export class RapidDrainDetector implements DetectorPlugin {
  readonly id = 'RAPID_DRAIN';
  readonly name = 'Rapid Drain Detector';
  readonly description =
    'Windowed detector that monitors cumulative outflow and triggers alerts when rolling drain volume or TVL percentage exceeds security thresholds';
  readonly type = 'WINDOWED' as const;

  async evaluate(context: DetectorContext): Promise<DetectionResult | null> {
    const { event, ruleParameters, eventHistoryProvider } = context;

    if (!ruleParameters) {
      return null;
    }

    // 1. Resolve sliding window duration (in seconds, default 5 minutes = 300s)
    let windowSeconds = 300;
    if (typeof ruleParameters.windowSeconds === 'number' && ruleParameters.windowSeconds > 0) {
      windowSeconds = ruleParameters.windowSeconds;
    } else if (typeof ruleParameters.windowMinutes === 'number' && ruleParameters.windowMinutes > 0) {
      windowSeconds = Math.round(ruleParameters.windowMinutes * 60);
    }

    // 2. Parse fixed cumulative volume threshold
    let volumeThreshold: bigint | null = null;
    const rawThreshold = ruleParameters.threshold ?? ruleParameters.volumeThreshold;
    if (rawThreshold !== undefined && rawThreshold !== null) {
      try {
        volumeThreshold = typeof rawThreshold === 'bigint' ? rawThreshold : BigInt(rawThreshold);
      } catch {
        volumeThreshold = null;
      }
    }

    // 3. Parse relative baseline reserve / TVL drain parameters
    let baselineReserve: bigint | null = null;
    const rawBaseline = ruleParameters.baselineReserve ?? ruleParameters.tvl;
    if (rawBaseline !== undefined && rawBaseline !== null) {
      try {
        baselineReserve = typeof rawBaseline === 'bigint' ? rawBaseline : BigInt(rawBaseline);
      } catch {
        baselineReserve = null;
      }
    }

    const maxDrainPercent =
      typeof ruleParameters.maxDrainPercent === 'number'
        ? ruleParameters.maxDrainPercent
        : typeof ruleParameters.drainPercent === 'number'
          ? ruleParameters.drainPercent
          : null;

    // If neither fixed threshold nor relative percentage is configured, rule is invalid
    if (volumeThreshold === null && (baselineReserve === null || maxDrainPercent === null)) {
      return null;
    }

    // 4. Extract current event's outflow amount
    const currentAmount = extractEventAmount(event) ?? 0n;

    // Filter topic if specified
    const targetTopic = ruleParameters.topic ? String(ruleParameters.topic).toLowerCase() : undefined;
    if (targetTopic) {
      const matchesTopic = event.topics.some(
        (t) => String(t).toLowerCase() === targetTopic
      );
      if (!matchesTopic && currentAmount === 0n) {
        return null;
      }
    }

    // 5. Query historical aggregate volume in window
    let historicalVolume = 0n;
    if (eventHistoryProvider) {
      try {
        historicalVolume = await eventHistoryProvider.getAggregateVolume(
          event.contractId,
          windowSeconds,
          targetTopic
        );
      } catch (err: any) {
        console.warn(
          `[RapidDrainDetector] Error fetching aggregate volume for ${event.contractId}:`,
          err?.message
        );
      }
    }

    // Total cumulative outflow including current transaction
    const cumulativeVolume = historicalVolume + currentAmount;

    if (cumulativeVolume <= 0n) {
      return null;
    }

    // 6. Evaluate criteria
    let triggered = false;
    let triggerReason = '';
    let outflowRatio = 0;

    // Check A: Fixed cumulative volume exceeded
    if (volumeThreshold !== null && cumulativeVolume >= volumeThreshold) {
      triggered = true;
      triggerReason = `Cumulative volume (${cumulativeVolume.toString()}) exceeded threshold (${volumeThreshold.toString()})`;
    }

    // Check B: Relative drain percentage of baseline reserve exceeded
    if (baselineReserve && baselineReserve > 0n && maxDrainPercent !== null) {
      outflowRatio = calculateOutflowRatio(cumulativeVolume, baselineReserve);
      if (outflowRatio >= maxDrainPercent) {
        triggered = true;
        const relativeReason = `Rolling outflow drained ${outflowRatio.toFixed(2)}% of baseline reserve (limit: ${maxDrainPercent}%)`;
        triggerReason = triggerReason ? `${triggerReason}; ${relativeReason}` : relativeReason;
      }
    }

    if (!triggered) {
      return null;
    }

    const velocityPerSecond = Number(cumulativeVolume) / windowSeconds;
    const configuredSeverity = ruleParameters.severity as Severity | undefined;
    const severity: Severity =
      configuredSeverity ||
      (outflowRatio >= 50 || (volumeThreshold && cumulativeVolume >= volumeThreshold * 2n)
        ? 'CRITICAL'
        : 'HIGH');

    return {
      triggered: true,
      severity,
      title: 'Rapid Liquidity Drain Detected',
      message: `Contract ${event.contractId} experienced rapid capital outflow over the last ${windowSeconds}s (${Math.round(windowSeconds / 60)}m): ${triggerReason}.`,
      metadata: {
        detectorType: this.id,
        cumulativeVolume: cumulativeVolume.toString(),
        currentEventAmount: currentAmount.toString(),
        historicalVolume: historicalVolume.toString(),
        windowSeconds,
        velocityPerSecond,
        triggerReason,
        ...(volumeThreshold ? { threshold: volumeThreshold.toString() } : {}),
        ...(baselineReserve ? { baselineReserve: baselineReserve.toString() } : {}),
        ...(maxDrainPercent !== null ? { maxDrainPercent } : {}),
        ...(outflowRatio > 0 ? { calculatedDrainPercent: outflowRatio } : {}),
      },
    };
  }
}

