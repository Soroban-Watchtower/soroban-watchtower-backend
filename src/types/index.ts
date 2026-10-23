/**
 * Domain Interfaces & Type Contracts for Soroban Watchdog
 * Architectural Blueprint - Interfaces defining system contracts
 */

export type Network = 'TESTNET' | 'MAINNET';

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type ChannelType = 'DISCORD' | 'TELEGRAM' | 'WEBHOOK';

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

export interface DetectorContext {
  event: DecodedSorobanEvent;
  ruleParameters: Record<string, any>;
  // For windowed detectors, repository interface to query historical events
  eventHistoryProvider?: {
    getEventsInWindow(contractId: string, windowSeconds: number): Promise<DecodedSorobanEvent[]>;
    getAggregateVolume(contractId: string, windowSeconds: number, topic: string): Promise<bigint>;
  };
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
