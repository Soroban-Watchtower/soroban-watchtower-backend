import {
  SorobanRpc,
  Contract,
  TransactionBuilder,
  Account,
  Networks,
  nativeToScVal,
} from '@stellar/stellar-sdk';
import { PrismaClient } from '@prisma/client';
import {
  AlertPayload,
  ResponseActionPolicy,
  ActionExecutionResult,
  ActionStatus,
} from '../types/index.js';
import { DefenderKeyVault, getDefenderKeyVault } from './keyVault.js';
import { getStreamBus, StreamBus } from '../server/streaming/streamBus.js';
import { prisma as defaultPrisma } from '../db/client.js';
import { config } from '../config/env.js';
import { logger } from '../observability/logger.js';
import {
  defensiveActionsTotal,
  defensiveActionDuration,
} from '../observability/metrics.js';

export interface IncidentResponderOptions {
  rpcUrl?: string;
  networkPassphrase?: string;
  keyVault?: DefenderKeyVault;
  prismaClient?: PrismaClient;
  streamBus?: StreamBus;
  confirmationTimeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * IncidentResponder
 * The active on-chain incident response engine of the Soroban Watchtower.
 * Automatically constructs, simulates, signs, and dispatches emergency defensive
 * transactions (such as pause, freeze, or circuit_breaker) to the Stellar network
 * in sub-second latency upon exploit detection.
 */
export class IncidentResponder {
  private readonly rpcServer: SorobanRpc.Server;
  private readonly networkPassphrase: string;
  private readonly keyVault: DefenderKeyVault;
  private readonly prisma: PrismaClient;
  private readonly streamBus: StreamBus;
  private readonly confirmationTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(options: IncidentResponderOptions = {}) {
    const rpcUrl = options.rpcUrl || config.SOROBAN_RPC_URL;
    this.rpcServer = new SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
    this.networkPassphrase = options.networkPassphrase || Networks.TESTNET;
    this.keyVault = options.keyVault || getDefenderKeyVault();
    this.prisma = options.prismaClient || defaultPrisma;
    this.streamBus = options.streamBus || getStreamBus();
    this.confirmationTimeoutMs = options.confirmationTimeoutMs || 15000;
    this.pollIntervalMs = options.pollIntervalMs || 1000;
  }

  /**
   * Executes an automated on-chain defensive intervention in response to an alert.
   */
  async executeDefensiveAction(
    alert: AlertPayload,
    policy: ResponseActionPolicy
  ): Promise<ActionExecutionResult> {
    const startTime = performance.now();
    const targetContractId = policy.targetContractId || alert.contractId;
    const functionName = policy.functionName || 'pause';

    logger.warn(
      {
        alertId: alert.alertId,
        contractId: targetContractId,
        functionName,
        simulationOnly: Boolean(policy.simulationOnly),
      },
      '[IncidentResponder] Initiating defensive circuit-breaker execution...'
    );

    // 1. Create PENDING audit execution record in PostgreSQL
    let executionRecord: any = null;
    try {
      executionRecord = await this.prisma.actionExecution.create({
        data: {
          ruleId: alert.ruleId,
          alertId: alert.alertId,
          contractId: targetContractId,
          actionType: policy.actionType,
          functionName,
          status: 'PENDING',
        },
      });
    } catch (dbErr: any) {
      logger.error({ dbErr }, '[IncidentResponder] Failed to create initial ActionExecution record:');
    }

    const executionId = executionRecord?.id || `exec_${Date.now()}`;

    try {
      // 2. Resolve Defender Guardian Source Account
      const defenderPublicKey = this.keyVault.getPublicKey();
      let sourceAccount: Account;

      try {
        const accountResponse = await this.rpcServer.getAccount(defenderPublicKey);
        const sequence =
          typeof (accountResponse as any).sequenceNumber === 'function'
            ? (accountResponse as any).sequenceNumber()
            : (accountResponse as any).sequence || '100';
        sourceAccount = new Account(defenderPublicKey, sequence);
      } catch {
        // Fallback sequence if account isn't funded yet or running in simulation/mock test mode
        sourceAccount = new Account(defenderPublicKey, '100');
      }

      // 3. Build Contract Invocation Operation
      const contract = new Contract(targetContractId);
      const scValArgs = (policy.args || []).map((arg) => {
        if (arg && typeof arg === 'object' && arg.switch) {
          return arg; // Already an ScVal
        }
        return nativeToScVal(arg);
      });

      const invokeOp = contract.call(functionName, ...scValArgs);

      // 4. Build Initial Raw Transaction for Simulation
      const baseTx = new TransactionBuilder(sourceAccount, {
        fee: '100',
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(invokeOp)
        .setTimeout(30)
        .build();

      // 5. Dry-Run Simulation on Soroban RPC
      const simResult = await this.rpcServer.simulateTransaction(baseTx);

      if (!SorobanRpc.Api.isSimulationSuccess(simResult)) {
        const simError =
          (simResult as any).error ||
          'Soroban host function simulation reverted or failed preconditions.';

        logger.error(
          { executionId, targetContractId, functionName, simError },
          '[IncidentResponder] Defensive simulation failed. Contract state cannot be modified.'
        );

        await this.updateRecord(executionId, {
          status: 'FAILED',
          errorLog: typeof simError === 'string' ? simError : JSON.stringify(simError),
          executionTimeMs: Math.round(performance.now() - startTime),
        });

        defensiveActionsTotal.inc({
          action_type: policy.actionType,
          function_name: functionName,
          status: 'simulation_failed',
        });

        return {
          executionId,
          status: 'FAILED',
          error: typeof simError === 'string' ? simError : 'Simulation reverted',
          executionTimeMs: Math.round(performance.now() - startTime),
        };
      }

      const minResourceFee = simResult.minResourceFee || '100';

      // 6. Verify Fee Against Policy Maximum Budget
      if (policy.maxResourceFee && BigInt(minResourceFee) > BigInt(policy.maxResourceFee)) {
        const feeError = `Simulated resource fee (${minResourceFee}) exceeds rule maxResourceFee (${policy.maxResourceFee})`;
        logger.error({ executionId, feeError }, '[IncidentResponder] Fee budget exceeded:');

        await this.updateRecord(executionId, {
          status: 'FAILED',
          simulatedFee: minResourceFee,
          errorLog: feeError,
          executionTimeMs: Math.round(performance.now() - startTime),
        });

        defensiveActionsTotal.inc({
          action_type: policy.actionType,
          function_name: functionName,
          status: 'fee_budget_exceeded',
        });

        return {
          executionId,
          status: 'FAILED',
          simulatedFee: minResourceFee,
          error: feeError,
          executionTimeMs: Math.round(performance.now() - startTime),
        };
      }

      // 7. Assemble Full Transaction with Resource Footprint & Auth Entries
      const assembledTx = SorobanRpc.assembleTransaction(baseTx, simResult).build();

      // 8. Handle Simulation-Only Mode (Dry-Run Verification)
      if (policy.simulationOnly) {
        const durationMs = Math.round(performance.now() - startTime);

        logger.info(
          { executionId, targetContractId, functionName, minResourceFee, durationMs },
          '[IncidentResponder] Defensive action successfully simulated (simulationOnly=true)'
        );

        await this.updateRecord(executionId, {
          status: 'SIMULATED',
          simulatedFee: minResourceFee,
          executionTimeMs: durationMs,
        });

        defensiveActionsTotal.inc({
          action_type: policy.actionType,
          function_name: functionName,
          status: 'simulated',
        });

        const result: ActionExecutionResult = {
          executionId,
          status: 'SIMULATED',
          simulatedFee: minResourceFee,
          executionTimeMs: durationMs,
        };

        this.streamBus.publishDefensiveAction(result);
        return result;
      }

      // 9. Sign with Defender Keypair
      const keypair = this.keyVault.getKeypair();
      assembledTx.sign(keypair);

      // 10. Broadcast Transaction to Stellar Network
      const sendResult = await this.rpcServer.sendTransaction(assembledTx);

      if (sendResult.status === 'ERROR') {
        const errorDetail =
          (sendResult as any).errorResultXdr ||
          (sendResult.errorResult ? JSON.stringify(sendResult.errorResult) : 'Unknown RPC error');
        const errorMsg = `RPC sendTransaction rejected: ${errorDetail}`;
        logger.error({ executionId, errorMsg }, '[IncidentResponder] Transaction broadcast failed');

        await this.updateRecord(executionId, {
          status: 'FAILED',
          simulatedFee: minResourceFee,
          errorLog: errorMsg,
          executionTimeMs: Math.round(performance.now() - startTime),
        });

        defensiveActionsTotal.inc({
          action_type: policy.actionType,
          function_name: functionName,
          status: 'send_failed',
        });

        return {
          executionId,
          status: 'FAILED',
          simulatedFee: minResourceFee,
          error: errorMsg,
          executionTimeMs: Math.round(performance.now() - startTime),
        };
      }

      const txHash = sendResult.hash;

      await this.updateRecord(executionId, {
        txHash,
        status: 'SUBMITTED',
        simulatedFee: minResourceFee,
      });

      // 11. Poll for On-Chain Ledger Inclusion
      const confirmation = await this.pollTransactionConfirmation(txHash);
      const totalTimeMs = Math.round(performance.now() - startTime);
      const latencySeconds = totalTimeMs / 1000;

      defensiveActionDuration.observe(latencySeconds, {
        action_type: policy.actionType,
        function_name: functionName,
      });

      if (confirmation.status === 'SUCCESS') {
        logger.warn(
          {
            executionId,
            txHash,
            targetContractId,
            functionName,
            ledger: confirmation.ledger?.toString(),
            durationMs: totalTimeMs,
          },
          '🛡️ [IncidentResponder] DEFENSIVE ACTION CONFIRMED ON-CHAIN! CONTRACT SECURED.'
        );

        await this.updateRecord(executionId, {
          status: 'CONFIRMED',
          ledgerSequence: confirmation.ledger,
          executionTimeMs: totalTimeMs,
        });

        defensiveActionsTotal.inc({
          action_type: policy.actionType,
          function_name: functionName,
          status: 'confirmed',
        });

        const result: ActionExecutionResult = {
          executionId,
          status: 'CONFIRMED',
          txHash,
          ledgerSequence: confirmation.ledger,
          simulatedFee: minResourceFee,
          executionTimeMs: totalTimeMs,
        };

        this.streamBus.publishDefensiveAction(result);
        return result;
      } else {
        const failMsg = `Transaction confirmed with failure status: ${confirmation.status}`;
        logger.error({ executionId, txHash, failMsg }, '[IncidentResponder] Action execution reverted on-chain');

        await this.updateRecord(executionId, {
          status: 'FAILED',
          errorLog: failMsg,
          executionTimeMs: totalTimeMs,
        });

        defensiveActionsTotal.inc({
          action_type: policy.actionType,
          function_name: functionName,
          status: 'onchain_revert',
        });

        return {
          executionId,
          status: 'FAILED',
          txHash,
          error: failMsg,
          executionTimeMs: totalTimeMs,
        };
      }
    } catch (fatalErr: any) {
      const errorMsg = `Catastrophic defensive execution failure: ${fatalErr.message}`;
      logger.error({ fatalErr, executionId }, errorMsg);

      await this.updateRecord(executionId, {
        status: 'FAILED',
        errorLog: errorMsg,
        executionTimeMs: Math.round(performance.now() - startTime),
      });

      defensiveActionsTotal.inc({
        action_type: policy.actionType,
        function_name: functionName,
        status: 'exception',
      });

      return {
        executionId,
        status: 'FAILED',
        error: errorMsg,
        executionTimeMs: Math.round(performance.now() - startTime),
      };
    }
  }

  /**
   * Performs an isolated dry-run simulation of an emergency invocation.
   */
  async simulateDryRun(
    contractId: string,
    functionName: string,
    args: any[] = []
  ): Promise<{ success: boolean; minResourceFee?: string; error?: string }> {
    try {
      const defenderPublicKey = this.keyVault.getPublicKey();
      const contract = new Contract(contractId);
      const scValArgs = args.map((arg) => (arg && arg.switch ? arg : nativeToScVal(arg)));
      const invokeOp = contract.call(functionName, ...scValArgs);

      const baseTx = new TransactionBuilder(new Account(defenderPublicKey, '100'), {
        fee: '100',
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(invokeOp)
        .setTimeout(30)
        .build();

      const sim = await this.rpcServer.simulateTransaction(baseTx);
      if (SorobanRpc.Api.isSimulationSuccess(sim)) {
        return { success: true, minResourceFee: sim.minResourceFee };
      }
      return { success: false, error: (sim as any).error || 'Simulation failed' };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Returns current Guardian status and public key.
   */
  getStatus() {
    return {
      publicKey: this.keyVault.getPublicKey(),
      isConfigured: this.keyVault.isConfigured(),
      networkPassphrase: this.networkPassphrase,
    };
  }

  private async pollTransactionConfirmation(
    hash: string
  ): Promise<{ status: 'SUCCESS' | 'FAILED' | 'TIMEOUT'; ledger?: bigint }> {
    const deadline = Date.now() + this.confirmationTimeoutMs;

    while (Date.now() < deadline) {
      try {
        const tx = await this.rpcServer.getTransaction(hash);
        if (tx.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
          return { status: 'SUCCESS', ledger: tx.ledger ? BigInt(tx.ledger) : undefined };
        }
        if (tx.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
          return { status: 'FAILED' };
        }
      } catch {
        // RPC getTransaction might 404 until transaction reaches consensus; continue polling
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }

    return { status: 'TIMEOUT' };
  }

  private async updateRecord(
    id: string,
    data: {
      status?: ActionStatus;
      txHash?: string;
      simulatedFee?: string;
      ledgerSequence?: bigint;
      errorLog?: string;
      executionTimeMs?: number;
    }
  ): Promise<void> {
    try {
      await this.prisma.actionExecution.update({
        where: { id },
        data,
      });
    } catch {
      // Non-blocking update failure (e.g. mocked in tests)
    }
  }
}

// Global singleton instance
let defaultResponder: IncidentResponder | null = null;

export function getIncidentResponder(options?: IncidentResponderOptions): IncidentResponder {
  if (!defaultResponder || options) {
    defaultResponder = new IncidentResponder(options);
  }
  return defaultResponder;
}

