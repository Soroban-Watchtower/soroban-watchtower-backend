import { Redis } from 'ioredis';
import { parseRedisConnection } from './alertQueue.js';
import { alertsSuppressedTotal } from '../observability/metrics.js';

export interface CooldownCheckResult {
  shouldDispatch: boolean;
  inCooldown: boolean;
  suppressedCount: number;
}

export interface CooldownManagerOptions {
  redisClient?: Redis;
  defaultCooldownSeconds?: number;
  useMemoryFallback?: boolean;
}

interface InMemoryCooldownEntry {
  expiresAt: number;
  count: number;
}

/**
 * AlertCooldownManager
 *
 * Sliding cooldown and deduplication engine that protects against alert fatigue.
 * Prevents downstream notification channels (Discord, Slack, Telegram, PagerDuty, Webhooks)
 * from being banned or rate-limited during high-frequency exploit loops.
 *
 * Supports distributed Redis keys with seamless in-memory fallback.
 */
export class AlertCooldownManager {
  private readonly redis?: Redis;
  private readonly defaultCooldownSeconds: number;
  private readonly memoryStore = new Map<string, InMemoryCooldownEntry>();

  constructor(options: CooldownManagerOptions = {}) {
    this.defaultCooldownSeconds = options.defaultCooldownSeconds ?? 300; // 5 minutes default
    this.redis = options.redisClient;
  }

  private buildKey(contractId: string, ruleId: string): string {
    return `watchdog:cooldown:${contractId}:${ruleId}`;
  }

  private buildCounterKey(contractId: string, ruleId: string): string {
    return `watchdog:cooldown:count:${contractId}:${ruleId}`;
  }

  /**
   * Determines whether an alert should be dispatched or throttled by active cooldown.
   * If cooling down, increments the suppressed counter and records observability metrics.
   * If clear, activates the cooldown window and permits dispatch.
   */
  async shouldDispatch(
    contractId: string,
    ruleId: string,
    cooldownSeconds?: number
  ): Promise<CooldownCheckResult> {
    const ttl = cooldownSeconds ?? this.defaultCooldownSeconds;

    if (ttl <= 0) {
      return { shouldDispatch: true, inCooldown: false, suppressedCount: 0 };
    }

    if (this.redis) {
      try {
        const cooldownKey = this.buildKey(contractId, ruleId);
        const counterKey = this.buildCounterKey(contractId, ruleId);

        const active = await this.redis.get(cooldownKey);
        if (active) {
          const suppressedCount = await this.redis.incr(counterKey);
          alertsSuppressedTotal.inc({ rule_id: ruleId, contract_id: contractId });
          return {
            shouldDispatch: false,
            inCooldown: true,
            suppressedCount: Number(suppressedCount),
          };
        }

        // Set cooldown key with expiration
        await this.redis.set(cooldownKey, 'active', 'EX', ttl);
        await this.redis.del(counterKey);

        return {
          shouldDispatch: true,
          inCooldown: false,
          suppressedCount: 0,
        };
      } catch (redisErr: any) {
        console.warn(
          `[AlertCooldownManager] Redis error, falling back to memory store: ${redisErr.message}`
        );
      }
    }

    // In-memory fallback
    const memKey = `${contractId}:${ruleId}`;
    const now = Date.now();
    const existing = this.memoryStore.get(memKey);

    if (existing && now < existing.expiresAt) {
      existing.count += 1;
      alertsSuppressedTotal.inc({ rule_id: ruleId, contract_id: contractId });
      return {
        shouldDispatch: false,
        inCooldown: true,
        suppressedCount: existing.count,
      };
    }

    this.memoryStore.set(memKey, {
      expiresAt: now + ttl * 1000,
      count: 0,
    });

    return {
      shouldDispatch: true,
      inCooldown: false,
      suppressedCount: 0,
    };
  }

  /**
   * Manually resets/clears a cooldown for a specific contract and rule.
   */
  async resetCooldown(contractId: string, ruleId: string): Promise<void> {
    const memKey = `${contractId}:${ruleId}`;
    this.memoryStore.delete(memKey);

    if (this.redis) {
      try {
        await this.redis.del(this.buildKey(contractId, ruleId));
        await this.redis.del(this.buildCounterKey(contractId, ruleId));
      } catch {
        // ignore redis error
      }
    }
  }

  /**
   * Clears all in-memory cooldown state (primarily for tests).
   */
  clear(): void {
    this.memoryStore.clear();
  }
}

/**
 * Factory helper for AlertCooldownManager.
 */
export function createCooldownManager(options?: CooldownManagerOptions): AlertCooldownManager {
  return new AlertCooldownManager(options);
}

