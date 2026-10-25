import { randomUUID } from 'node:crypto';
import { prisma as defaultPrisma } from '../db/client.js';
import {
  DecodedSorobanEvent,
  DetectorPlugin,
  DetectorContext,
  DetectionResult,
  AlertPayload,
  Severity,
  Network,
} from '../types/index.js';
import { LargeTransferDetector } from './LargeTransferDetector.js';
import { EmergencyPauseDetector } from './EmergencyPauseDetector.js';

/**
 * Standard rule definition matching the domain and database schema.
 */
export interface RuleDefinition {
  id: string;
  contractId: string;
  name: string;
  detectorType: string;
  severity?: Severity;
  parameters: Record<string, any>;
  enabled: boolean;
}

/**
 * Interface for loading active contract rules.
 */
export interface RuleProvider {
  getRulesForContract(contractId: string): Promise<RuleDefinition[]>;
}

/**
 * Default rule provider using Prisma client.
 */
export class DatabaseRuleProvider implements RuleProvider {
  constructor(private readonly prismaClient: typeof defaultPrisma = defaultPrisma) {}

  async getRulesForContract(contractId: string): Promise<RuleDefinition[]> {
    try {
      const records = await this.prismaClient.rule.findMany({
        where: {
          contractId,
          enabled: true,
        },
      });

      return records.map((r) => ({
        id: r.id,
        contractId: r.contractId,
        name: r.name,
        detectorType: r.detectorType,
        severity: r.severity as Severity,
        parameters: (r.parameters as Record<string, any>) ?? {},
        enabled: r.enabled,
      }));
    } catch (err) {
      console.error(`[DetectorRunner] Failed to fetch rules for contract ${contractId}:`, err);
      return [];
    }
  }
}

/**
 * In-memory rule provider for testing and programmatic rule configuration.
 */
export class InMemoryRuleProvider implements RuleProvider {
  private rulesByContract = new Map<string, RuleDefinition[]>();

  constructor(rules: RuleDefinition[] = []) {
    for (const rule of rules) {
      this.addRule(rule);
    }
  }

  addRule(rule: RuleDefinition): void {
    const existing = this.rulesByContract.get(rule.contractId) || [];
    existing.push(rule);
    this.rulesByContract.set(rule.contractId, existing);
  }

  setRules(contractId: string, rules: RuleDefinition[]): void {
    this.rulesByContract.set(contractId, rules);
  }

  async getRulesForContract(contractId: string): Promise<RuleDefinition[]> {
    const rules = this.rulesByContract.get(contractId) || [];
    return rules.filter((r) => r.enabled);
  }
}

/**
 * Registry holding all available detector plugins.
 * Enables pluggable extensibility so contributors can register new detectors in a single line.
 */
export class DetectorRegistry {
  private detectors = new Map<string, DetectorPlugin>();
  private aliases = new Map<string, string>();

  constructor() {
    this.registerDefaults();
  }

  /**
   * Registers the core default detector plugins with their standard aliases.
   */
  private registerDefaults(): void {
    this.register(new LargeTransferDetector(), [
      'LARGE_TRANSFER',
      'LARGE_VALUE_TRANSFER',
      'large_transfer',
      'large_value_transfer',
    ]);
    this.register(new EmergencyPauseDetector(), [
      'EMERGENCY_PAUSE',
      'EMERGENCY_PAUSE_TRIGGERED',
      'emergency_pause',
      'emergency_pause_triggered',
    ]);
  }

  /**
   * Normalizes an identifier string for case-insensitive lookup.
   */
  private normalizeKey(key: string): string {
    return key.trim().toUpperCase().replace(/[-_]/g, '_');
  }

  /**
   * Registers a detector plugin with optional aliases.
   */
  register(plugin: DetectorPlugin, aliases: string[] = []): void {
    const primaryKey = this.normalizeKey(plugin.id);
    this.detectors.set(primaryKey, plugin);

    for (const alias of aliases) {
      const aliasKey = this.normalizeKey(alias);
      this.aliases.set(aliasKey, primaryKey);
    }
  }

  /**
   * Retrieves a detector plugin by ID or alias.
   */
  get(idOrAlias: string): DetectorPlugin | undefined {
    if (!idOrAlias) return undefined;
    const normalized = this.normalizeKey(idOrAlias);

    const directMatch = this.detectors.get(normalized);
    if (directMatch) return directMatch;

    const targetKey = this.aliases.get(normalized);
    if (targetKey) {
      return this.detectors.get(targetKey);
    }

    return undefined;
  }

  /**
   * Returns all registered unique detector plugins.
   */
  getAll(): DetectorPlugin[] {
    return Array.from(new Set(this.detectors.values()));
  }
}

/**
 * Constructs a block explorer URL for transaction forensics.
 */
export function buildExplorerUrl(txHash: string, network: Network = 'TESTNET'): string {
  if (!txHash) return '';
  const networkSegment = network === 'MAINNET' ? 'public' : 'testnet';
  return `https://stellar.expert/explorer/${networkSegment}/tx/${txHash}`;
}

/**
 * Result of evaluating a single rule on an event.
 */
export interface DetectionExecutionResult {
  rule: RuleDefinition;
  detectorId: string;
  result: DetectionResult | null;
  alertPayload?: AlertPayload;
  persistedAlertId?: string;
  error?: string;
}

export interface EvaluateEventOptions {
  rules?: RuleDefinition[];
  persistAlerts?: boolean;
}

export interface DetectorRunnerOptions {
  registry?: DetectorRegistry;
  ruleProvider?: RuleProvider;
  prismaClient?: typeof defaultPrisma;
  network?: Network;
  eventHistoryProvider?: DetectorContext['eventHistoryProvider'];
  onAlert?: (alert: AlertPayload) => Promise<void> | void;
}

/**
 * DetectorRunner
 *
 * Core analytical orchestrator that executes active rule checks against decoded events.
 * Manages detector plugins, evaluates context, handles persistence, and emits alert payloads.
 */
export class DetectorRunner {
  readonly registry: DetectorRegistry;
  private readonly ruleProvider: RuleProvider;
  private readonly prismaClient?: typeof defaultPrisma;
  private readonly network: Network;
  private readonly eventHistoryProvider?: DetectorContext['eventHistoryProvider'];
  private readonly onAlert?: (alert: AlertPayload) => Promise<void> | void;

  constructor(options: DetectorRunnerOptions = {}) {
    this.registry = options.registry || new DetectorRegistry();
    this.ruleProvider = options.ruleProvider || new DatabaseRuleProvider(options.prismaClient);
    this.prismaClient = options.prismaClient;
    this.network = options.network || 'TESTNET';
    this.eventHistoryProvider = options.eventHistoryProvider;
    this.onAlert = options.onAlert;
  }

  /**
   * Registers a new detector plugin to expand detection capabilities.
   */
  registerDetector(plugin: DetectorPlugin, aliases: string[] = []): void {
    this.registry.register(plugin, aliases);
  }

  /**
   * Retrieves a detector plugin by ID or alias.
   */
  getDetector(idOrAlias: string): DetectorPlugin | undefined {
    return this.registry.get(idOrAlias);
  }

  /**
   * Evaluates all active rules for a single decoded event.
   */
  async evaluateEvent(
    event: DecodedSorobanEvent,
    options: EvaluateEventOptions = {}
  ): Promise<DetectionExecutionResult[]> {
    const results: DetectionExecutionResult[] = [];

    // Resolve rules: either passed explicitly in options or fetched via ruleProvider
    const rules = options.rules ?? (await this.ruleProvider.getRulesForContract(event.contractId));

    if (!rules || rules.length === 0) {
      return results;
    }

    for (const rule of rules) {
      if (!rule.enabled) {
        continue;
      }

      const detector = this.registry.get(rule.detectorType);
      if (!detector) {
        console.warn(
          `[DetectorRunner] No detector plugin registered for type '${rule.detectorType}' (Rule: ${rule.id} - ${rule.name})`
        );
        continue;
      }

      const context: DetectorContext = {
        event,
        ruleParameters: {
          ...rule.parameters,
          ...(rule.severity ? { severity: rule.severity } : {}),
        },
        eventHistoryProvider: this.eventHistoryProvider,
      };

      try {
        const detectionResult = await detector.evaluate(context);

        if (detectionResult && detectionResult.triggered) {
          const alertId = randomUUID();
          const alertPayload: AlertPayload = {
            alertId,
            contractId: event.contractId,
            ruleId: rule.id,
            severity: detectionResult.severity,
            title: detectionResult.title,
            message: detectionResult.message,
            timestamp: event.ledgerClosedAt || new Date(),
            metadata: {
              ...detectionResult.metadata,
              ruleName: rule.name,
              detectorType: rule.detectorType,
              txHash: event.txHash,
              ledger: event.ledger.toString(),
            },
            explorerUrl: buildExplorerUrl(event.txHash, this.network),
          };

          let persistedAlertId: string | undefined;

          // Optional database persistence
          if (options.persistAlerts !== false && this.prismaClient) {
            try {
              const created = await this.prismaClient.alert.create({
                data: {
                  id: alertId,
                  contractId: event.contractId,
                  ruleId: rule.id,
                  eventId: event.id || null,
                  severity: alertPayload.severity,
                  title: alertPayload.title,
                  message: alertPayload.message,
                  metadata: alertPayload.metadata,
                },
              });
              persistedAlertId = created.id;
            } catch (dbErr) {
              console.error(
                `[DetectorRunner] Failed to persist alert ${alertId} to database:`,
                dbErr
              );
            }
          }

          // Trigger onAlert callback if defined
          if (this.onAlert) {
            try {
              await this.onAlert(alertPayload);
            } catch (cbErr) {
              console.error(`[DetectorRunner] onAlert callback failed:`, cbErr);
            }
          }

          results.push({
            rule,
            detectorId: detector.id,
            result: detectionResult,
            alertPayload,
            persistedAlertId,
          });
        } else {
          results.push({
            rule,
            detectorId: detector.id,
            result: detectionResult,
          });
        }
      } catch (err: any) {
        console.error(
          `[DetectorRunner] Error evaluating rule ${rule.id} (${detector.id}) on event ${event.id}:`,
          err
        );
        results.push({
          rule,
          detectorId: detector.id,
          result: null,
          error: err?.message ?? String(err),
        });
      }
    }

    return results;
  }

  /**
   * Evaluates a batch of decoded events in sequence.
   */
  async evaluateBatch(
    events: DecodedSorobanEvent[],
    options: EvaluateEventOptions = {}
  ): Promise<DetectionExecutionResult[]> {
    const allResults: DetectionExecutionResult[] = [];
    for (const event of events) {
      const eventResults = await this.evaluateEvent(event, options);
      allResults.push(...eventResults);
    }
    return allResults;
  }
}

/**
 * Creates a configured DetectorRunner instance.
 */
export function createDetectorRunner(options?: DetectorRunnerOptions): DetectorRunner {
  return new DetectorRunner(options);
}
