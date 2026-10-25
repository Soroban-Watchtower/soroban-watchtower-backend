import {
  DetectorPlugin,
  DetectorContext,
  DetectionResult,
  Severity,
} from '../types/index.js';
import { parseSacEvent } from '../decoder/eventDecoder.js';

/**
 * LargeTransferDetector (Stateless Rule)
 *
 * Inspects contract events (both standard SEP-41 SAC and custom token events)
 * to detect transfer amounts that exceed a configured threshold.
 */
export class LargeTransferDetector implements DetectorPlugin {
  readonly id = 'LARGE_TRANSFER';
  readonly name = 'Large Transfer Detector';
  readonly description = 'Stateless detector that triggers alerts when transfer amounts exceed a configured threshold';
  readonly type = 'STATELESS' as const;

  /**
   * Evaluates a decoded event against rule threshold parameters.
   */
  async evaluate(context: DetectorContext): Promise<DetectionResult | null> {
    const { event, ruleParameters } = context;

    if (!ruleParameters || ruleParameters.threshold === undefined || ruleParameters.threshold === null) {
      return null;
    }

    // Parse threshold parameter safely to BigInt
    let threshold: bigint;
    try {
      if (typeof ruleParameters.threshold === 'bigint') {
        threshold = ruleParameters.threshold;
      } else if (
        typeof ruleParameters.threshold === 'string' ||
        typeof ruleParameters.threshold === 'number'
      ) {
        threshold = BigInt(ruleParameters.threshold);
      } else {
        return null;
      }
    } catch {
      return null;
    }

    if (threshold < 0n) {
      return null;
    }

    // 1. Try parsing as standard SAC (Stellar Asset Contract / SEP-41) event
    const sacEvent = parseSacEvent(event);
    let amount: bigint | null = null;
    let from: string | undefined;
    let to: string | undefined;

    if (sacEvent && sacEvent.action === 'transfer' && sacEvent.amount !== undefined) {
      amount = sacEvent.amount;
      from = sacEvent.from;
      to = sacEvent.to;
    } else {
      // 2. Fallback: inspect generic contract events with topic 'transfer'
      const isTransferTopic = event.topics.some((topic) => {
        const topicStr = String(topic).toLowerCase();
        return topicStr === 'transfer';
      });

      if (!isTransferTopic) {
        return null;
      }

      // Extract addresses from topics if available: ['transfer', from, to]
      if (event.topics.length >= 2 && event.topics[1]) {
        from = String(event.topics[1]);
      }
      if (event.topics.length >= 3 && event.topics[2]) {
        to = String(event.topics[2]);
      }

      // Extract amount from event.data or topics
      if (typeof event.data === 'bigint') {
        amount = event.data;
      } else if (typeof event.data === 'number' || typeof event.data === 'string') {
        try {
          amount = BigInt(event.data);
        } catch {
          amount = null;
        }
      } else if (event.data && typeof event.data === 'object') {
        const candidate = event.data.amount ?? event.data.value;
        if (candidate !== undefined) {
          try {
            amount = typeof candidate === 'bigint' ? candidate : BigInt(candidate);
          } catch {
            amount = null;
          }
        }
      }
    }

    // If no valid non-negative amount was found, do not trigger
    if (amount === null || amount < 0n) {
      return null;
    }

    // Trigger alert if amount strictly exceeds configured threshold
    if (amount > threshold) {
      const severity: Severity = (ruleParameters.severity as Severity) || 'HIGH';
      const formattedAmount = amount.toString();
      const formattedThreshold = threshold.toString();

      return {
        triggered: true,
        severity,
        title: 'Large Transfer Detected',
        message: `Transfer of ${formattedAmount} exceeded configured threshold of ${formattedThreshold} on contract ${event.contractId}`,
        metadata: {
          contractId: event.contractId,
          amount: formattedAmount,
          threshold: formattedThreshold,
          from: from ?? 'unknown',
          to: to ?? 'unknown',
          txHash: event.txHash,
          ledger: event.ledger.toString(),
          timestamp: event.ledgerClosedAt.toISOString(),
        },
      };
    }

    return null;
  }
}
