/**
 * Domain Interfaces & Type Contracts for Soroban Watchdog
 * Architectural Blueprint - Interfaces defining system contracts
 */

export type Network = 'TESTNET' | 'MAINNET';

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type ChannelType = 'DISCORD' | 'TELEGRAM' | 'WEBHOOK' | 'SLACK' | 'PAGERDUTY';

export type DeliveryStatus = 'PENDING' | 'DELIVERED' | 'FAILED';

export interface DecodedSorobanEvent {
  id: string; // {ledgerSequence}-{txIndex}-{eventIndex}
  contractId: string;
  type: 'contract' | 'system' | 'diagnostic';
  ledger: bigint;
  ledgerClosedAt: Date;
  txHash: string;
  topics: (string | number | bigint)[];
  data: any;
  rawXdr: string;
}

export interface EventHistoryProvider {
  getEventsInWindow(contractId: string, windowSeconds: number): Promise<DecodedSorobanEvent[]>;
  getAggregateVolume(contractId: string, windowSeconds: number, topic?: string): Promise<bigint>;
  getFailedEventCountInWindow?(contractId: string, windowSeconds: number): Promise<number>;
}

export interface DetectorContext {
  event: DecodedSorobanEvent;
  ruleParameters: Record<string, any>;
  // For windowed detectors, repository interface to query historical events
  eventHistoryProvider?: EventHistoryProvider;
}

export interface DetectionResult {
  triggered: boolean;
  severity: Severity;
  title: string;
  message: string;
  metadata: Record<string, any>;
}

export interface DetectorPlugin {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly type: 'STATELESS' | 'WINDOWED';
  evaluate(context: DetectorContext): Promise<DetectionResult | null>;
}

export interface AlertPayload {
  alertId: string;
  contractId: string;
  ruleId: string;
  severity: Severity;
  title: string;
  message: string;
  timestamp: Date;
  metadata: Record<string, any>;
  explorerUrl: string;
}

export interface DeliveryResult {
  success: boolean;
  statusCode?: number;
  error?: string;
  sentAt: Date;
}

export interface NotifierPlugin {
  readonly type: ChannelType;
  send(payload: AlertPayload, destination: string, secret?: string): Promise<DeliveryResult>;
}

// -------------------------------------------------------------
// Authentication & API Key Gateway
// -------------------------------------------------------------
export type ApiKeyScope =
  | 'read:telemetry'
  | 'read:alerts'
  | 'read:events'
  | 'write:contracts'
  | 'write:rules'
  | 'admin:channels'
  | 'admin:keys'
  | '*';

export interface ApiKeyIdentity {
  id: string;
  name: string;
  keyPrefix: string;
  roles: string[];
  isMaster?: boolean;
}

// -------------------------------------------------------------
// Real-Time Streaming Bus
// -------------------------------------------------------------
export type StreamEventType = 'alert' | 'contract_event' | 'telemetry' | 'defensive_action' | 'keepalive' | 'connected';

export interface StreamFilter {
  contractId?: string;
  severity?: Severity;
  eventType?: string;
}

export interface StreamMessage<T = any> {
  id?: string;
  event: StreamEventType;
  data: T;
  timestamp: string;
}

// -------------------------------------------------------------
// Automated On-Chain Incident Response & Defense
// -------------------------------------------------------------
export type ActionStatus = 'PENDING' | 'SIMULATED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED';

export interface ResponseActionPolicy {
  enabled: boolean;
  actionType: 'INVOKE_CONTRACT';
  targetContractId?: string; // Target contract (defaults to alert's contractId)
  functionName: string; // e.g. 'pause', 'freeze', 'emergency_stop'
  args?: any[]; // Soroban function arguments
  maxResourceFee?: string; // Max gas/resource fee in stroops (e.g. '5000000')
  simulationOnly?: boolean; // Dry-run verification mode (no network broadcast)
}

export interface ActionExecutionResult {
  executionId: string;
  status: ActionStatus;
  txHash?: string;
  ledgerSequence?: bigint;
  simulatedFee?: string;
  error?: string;
  executionTimeMs: number;
}


