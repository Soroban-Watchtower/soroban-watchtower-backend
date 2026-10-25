import {
  DetectorPlugin,
  DetectorContext,
  DetectionResult,
  Severity,
} from '../types/index.js';

/**
 * Standard list of emergency/pause topic keywords commonly used
 * in Soroban smart contracts and DeFi protocols.
 */
export const DEFAULT_PAUSE_KEYWORDS = [
  'pause',
  'paused',
  'emergency_pause',
  'emergency_stop',
  'freeze',
  'frozen',
  'circuit_breaker',
  'halt',
  'stop',
] as const;

/**
 * EmergencyPauseDetector (Stateless Rule)
 *
 * Inspects contract events for emergency pause, circuit breaker, or asset freeze
 * invocations, and triggers a CRITICAL alert.
 */
export class EmergencyPauseDetector implements DetectorPlugin {
  readonly id = 'EMERGENCY_PAUSE';
  readonly name = 'Emergency Pause Detector';
  readonly description = 'Stateless detector that flags emergency pause, freeze, or circuit breaker invocations';
  readonly type = 'STATELESS' as const;

  /**
   * Evaluates if the event matches any pause/freeze criteria.
   */
  async evaluate(context: DetectorContext): Promise<DetectionResult | null> {
    const { event, ruleParameters } = context;

    // Collect target keywords (defaults + any custom keywords in ruleParameters)
    const targetKeywords = new Set<string>(DEFAULT_PAUSE_KEYWORDS.map((k) => k.toLowerCase()));

    if (ruleParameters?.pauseTopics && Array.isArray(ruleParameters.pauseTopics)) {
      for (const customKeyword of ruleParameters.pauseTopics) {
        if (typeof customKeyword === 'string' && customKeyword.trim()) {
          targetKeywords.add(customKeyword.trim().toLowerCase());
        }
      }
    }

    if (ruleParameters?.keywords && Array.isArray(ruleParameters.keywords)) {
      for (const customKeyword of ruleParameters.keywords) {
        if (typeof customKeyword === 'string' && customKeyword.trim()) {
          targetKeywords.add(customKeyword.trim().toLowerCase());
        }
      }
    }

    let matchedTopic: string | null = null;

    // 1. Check all event topics
    if (event.topics && Array.isArray(event.topics)) {
      for (const topic of event.topics) {
        const normalized = String(topic).trim().toLowerCase();
        if (targetKeywords.has(normalized)) {
          matchedTopic = String(topic);
          break;
        }
      }
    }

    // 2. Check event.data if it contains a matching string, action, or method
    if (!matchedTopic && event.data !== undefined && event.data !== null) {
      if (typeof event.data === 'string') {
        const normalized = event.data.trim().toLowerCase();
        if (targetKeywords.has(normalized)) {
          matchedTopic = event.data;
        }
      } else if (typeof event.data === 'object') {
        const candidateAction =
          event.data.action ??
          event.data.method ??
          event.data.event ??
          event.data.type;
        if (typeof candidateAction === 'string') {
          const normalized = candidateAction.trim().toLowerCase();
          if (targetKeywords.has(normalized)) {
            matchedTopic = candidateAction;
          }
        }
      }
    }

    // If an emergency pause topic was detected, trigger CRITICAL alert
    if (matchedTopic) {
      const severity: Severity = (ruleParameters?.severity as Severity) || 'CRITICAL';

      return {
        triggered: true,
        severity,
        title: `Emergency Pause Triggered: ${matchedTopic}`,
        message: `Contract ${event.contractId} emitted emergency event '${matchedTopic}' in transaction ${event.txHash || 'unknown'}`,
        metadata: {
          contractId: event.contractId,
          matchedTopic,
          allTopics: event.topics.map((t) => String(t)),
          data: event.data,
          txHash: event.txHash,
          ledger: event.ledger.toString(),
          timestamp: event.ledgerClosedAt.toISOString(),
        },
      };
    }

    return null;
  }
}
