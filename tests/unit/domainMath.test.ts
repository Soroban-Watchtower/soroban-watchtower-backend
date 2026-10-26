import { describe, it, expect } from 'vitest';
import {
  calculateVolumeVelocity,
  calculateOutflowRatio,
  calculateFrequency,
  summarizeTelemetry,
} from '../../src/lib/domainMath.js';

describe('Pure Domain Math & In-Memory Telemetry Aggregation (src/lib/domainMath)', () => {
  it('should accurately compute volume velocity and average per event', () => {
    const items = [
      { amount: 1000n },
      { amount: 2000n },
      { amount: 3000n },
    ];

    const result = calculateVolumeVelocity(items, 60);

    expect(result.totalVolume).toBe(6000n);
    expect(result.eventCount).toBe(3);
    expect(result.averageAmountPerEvent).toBe(2000n);
    expect(result.velocityPerSecond).toBe(100);
  });

  it('should accurately compute capital outflow ratio with integer precision', () => {
    const outflow = 2500n;
    const baseline = 10000n;
    const ratio = calculateOutflowRatio(outflow, baseline);
    expect(ratio).toBe(25); // 25.00%

    // Edge cases
    expect(calculateOutflowRatio(0n, baseline)).toBe(0);
    expect(calculateOutflowRatio(outflow, 0n)).toBe(0);
  });

  it('should accurately compute event frequency and burst peak per second', () => {
    const baseTime = 1700000000000;
    const timestamps = [
      new Date(baseTime),
      new Date(baseTime + 200),
      new Date(baseTime + 400), // 3 events in second 1
      new Date(baseTime + 1500),
      new Date(baseTime + 2500),
    ];

    const result = calculateFrequency(timestamps, 10);

    expect(result.totalEvents).toBe(5);
    expect(result.windowSeconds).toBe(10);
    expect(result.eventsPerSecond).toBe(0.5);
    expect(result.eventsPerMinute).toBe(30);
    expect(result.burstCountMax).toBe(3);
  });

  it('should produce a zero-chain-roundtrip telemetry summary object', () => {
    const events = [
      { ledgerClosedAt: new Date(), data: { amount: '5000000000' } },
      { ledgerClosedAt: new Date(), data: { amount: '15000000000' } },
    ];

    const summary = summarizeTelemetry('C123', events, 0n, 60);

    expect(summary.contractId).toBe('C123');
    expect(summary.totalEvents).toBe(2);
    expect(summary.totalVolume).toBe('20000000000');
    expect(summary.lagLedgers).toBe(0);
    expect(summary.isHealthy).toBe(true);
  });
});
