import {
  DetectorPlugin,
  DetectorContext,
  DetectionResult,
  Severity,
} from '../types/index.js';

/**
 * Common topic keywords indicating a contract invocation failure, revert, or panic in Soroban.
 */
export const FAILURE_KEYWORDS = [
  'error',
  'revert',
  'failed',
  'trap',
  'panic',
  'abort',
  'assert',
  'unauthorized',
] as const;

/**
 * FailedTxBurstDetector (Windowed Rule)
 *
 * Surveillance detector for exploit probing and brute-force attempts.
 * When threat actors attempt to discover or weaponize an exploit on a Soroban contract,
 * their preliminary attempts frequently revert with diagnostic error events or dead-letter failures.
 * A high burst of failed transactions in a short window signals an active probe or attack.
 */
export class FailedTxBurstDetector implements DetectorPlugin {
  readonly id = 'FAILED_TX_BURST';
  readonly name = 'Failed Transaction Burst Detector';
  readonly description =
    'Windowed detector that identifies exploit probing, brute-force attacks, and panic bursts from recurring contract execution reverts';
  readonly type = 'WINDOWED' as const;

  async evaluate(context: DetectorContext): Promise<DetectionResult | null> {
    const { event, ruleParameters, eventHistoryProvider } = context;

    if (!ruleParameters) {
      return null;
    }

    // 1. Resolve sliding window duration (default: 60s / 1m)
    let windowSeconds = 60;
    if (typeof ruleParameters.windowSeconds === 'number' && ruleParameters.windowSeconds > 0) {
      windowSeconds = ruleParameters.windowSeconds;
    } else if (typeof ruleParameters.windowMinutes === 'number' && ruleParameters.windowMinutes > 0) {
      windowSeconds = Math.round(ruleParameters.windowMinutes * 60);
    }

    // 2. Resolve burst threshold (default: 5 failures)
    const burstThreshold =
      typeof ruleParameters.burstThreshold === 'number' && ruleParameters.burstThreshold > 0
        ? ruleParameters.burstThreshold
        : typeof ruleParameters.maxFailures === 'number' && ruleParameters.maxFailures > 0
          ? ruleParameters.maxFailures
          : 5;

    // 3. Inspect if current event represents a failure or diagnostic error
    const isDiagnostic = event.type === 'diagnostic';
    const hasFailureTopic = event.topics.some((topic) => {
      const s = String(topic).toLowerCase();
      return FAILURE_KEYWORDS.some((kw) => s.includes(kw));
    });
    const hasFailureData =
      event.data &&
      typeof event.data === 'object' &&
      (event.data.error !== undefined || event.data.code !== undefined || event.data.revert !== undefined);

    const isCurrentEventFailure = isDiagnostic || hasFailureTopic || Boolean(hasFailureData);

    // 4. Query historical failures in window
    let historicalFailures = 0;
    if (eventHistoryProvider && typeof eventHistoryProvider.getFailedEventCountInWindow === 'function') {
      try {
        historicalFailures = await eventHistoryProvider.getFailedEventCountInWindow(
          event.contractId,
          windowSeconds
        );
      } catch (err: any) {
        console.warn(
          `[FailedTxBurstDetector] Error querying failed event count for ${event.contractId}:`,
          err?.message
        );
      }
    }

    // Total failures in window
    const totalFailures = historicalFailures + (isCurrentEventFailure ? 1 : 0);

    if (totalFailures < burstThreshold) {
      return null;
    }

    const ratePerMinute = (totalFailures / windowSeconds) * 60;
    const configuredSeverity = ruleParameters.severity as Severity | undefined;
    const severity: Severity =
      configuredSeverity || (totalFailures >= 15 ? 'CRITICAL' : 'HIGH');

    return {
      triggered: true,
      severity,
      title: 'Exploit Probe Detected: Rapid Transaction Revert Burst',
      message: `Contract ${event.contractId} encountered a burst of ${totalFailures} failed/reverting transactions within a ${windowSeconds}s window (threshold: ${burstThreshold}). This pattern strongly indicates active exploit probing or brute-force invocation attempts.`,
      metadata: {
        detectorType: this.id,
        failureCount: totalFailures,
        burstThreshold,
        windowSeconds,
        ratePerMinute,
        isCurrentEventFailure,
        sampleTxHash: event.txHash,
        sampleEventId: event.id,
      },
    };
  }
}

