import { describe, it, expect, vi } from 'vitest';
import { runSimulation } from '../../src/simulate.js';

describe('Step 10: End-to-End Simulation & Testnet Run (src/simulate)', () => {
  it('should successfully execute all 4 phases of the live threat surveillance lifecycle', async () => {
    const result = await runSimulation({
      verbose: false,
    });

    // 1. Contract & Configuration
    expect(result.success).toBe(true);
    expect(result.contractId).toBeDefined();
    expect(result.contractId.startsWith('C')).toBe(true);

    // 2. Stellar Testnet Ingestion & XDR Decoding
    expect(typeof result.testnetLedger).toBe('number');
    expect(result.testnetLedger).toBeGreaterThan(0);
    expect(result.decodedEvent).toBeDefined();
    expect(result.decodedEvent.type).toBe('contract');
    expect(result.decodedEvent.topics[0]).toBe('transfer');
    expect(result.decodedEvent.data).toBe(50_000_000_000_000n);

    // 3. Rule Detection & Alert Generation
    expect(result.alert).toBeDefined();
    expect(result.alert.severity).toBe('CRITICAL');
    expect(result.alert.title).toContain('Large Transfer Detected');
    expect(result.alert.ruleId).toBe('rule-e2e-large-transfer');
    expect(result.alert.metadata.detectorType).toBe('LARGE_VALUE_TRANSFER');

    // 4. BullMQ Queue & Cryptographic Delivery
    expect(result.delivery).toBeDefined();
    expect(result.delivery.channelType).toBe('WEBHOOK');
    expect(result.delivery.statusCode).toBe(200);
    expect(result.delivery.signatureVerified).toBe(true);
    expect(result.delivery.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it('should support custom threshold and transfer amounts', async () => {
    const customThreshold = 5_000_000_000_000n; // 500,000 USDC
    const customTransfer = 20_000_000_000_000n; // 2,000,000 USDC

    const result = await runSimulation({
      threshold: customThreshold,
      transferAmount: customTransfer,
      verbose: false,
    });

    expect(result.success).toBe(true);
    expect(result.decodedEvent.data).toBe(customTransfer);
    expect(result.alert.message).toContain(customTransfer.toString());
    expect(result.delivery.statusCode).toBe(200);
  });
});
