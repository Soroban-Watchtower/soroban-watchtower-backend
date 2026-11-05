import { EventEmitter } from 'node:events';

export interface ContractEventData {
  id: string;
  name?: string;
  network?: string;
  active?: boolean;
}

/**
 * In-process event emitter for real-time contract lifecycle events.
 * Enables the IngestionPoller to dynamically reconfigure its monitored contracts
 * and shards the instant a contract is registered, updated, or removed via the REST API.
 */
export class ContractEventEmitter extends EventEmitter {
  emitContractRegistered(data: ContractEventData): boolean {
    return this.emit('contract:registered', data);
  }

  emitContractUpdated(data: ContractEventData): boolean {
    return this.emit('contract:updated', data);
  }

  emitContractDeleted(contractId: string): boolean {
    return this.emit('contract:deleted', { id: contractId });
  }
}

// Global contract event bus singleton
export const contractEvents = new ContractEventEmitter();
