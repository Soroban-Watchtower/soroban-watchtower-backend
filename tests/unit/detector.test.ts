import { describe, it, expect, vi } from 'vitest';
import {
  LargeTransferDetector,
  EmergencyPauseDetector,
  RapidDrainDetector,
  FailedTxBurstDetector,
  DatabaseEventHistoryProvider,
  InMemoryEventHistoryProvider,
  DetectorRunner,
  DetectorRegistry,
  InMemoryRuleProvider,
  RuleDefinition,
  buildExplorerUrl,
} from '../../src/detectors/index.js';
import {
  DecodedSorobanEvent,
  DetectorPlugin,
  DetectorContext,
  DetectionResult,
} from '../../src/types/index.js';

describe('Rule & Detector Engine (src/detectors)', () => {
  const dummyContractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
  const dummyAccountA = 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2G6VR7Y8JD6NOQQ4ABU2T';
  const dummyAccountB = 'GBVOL6ZZPIGQACU75G5C47OAWJ72X3G2XGBU5YF352HRPN7M526Z6EGL';

  const createMockEvent = (overrides: Partial<DecodedSorobanEvent> = {}): DecodedSorobanEvent => ({
    id: '123456-1-0',
    contractId: dummyContractId,
    type: 'contract',
    ledger: 123456n,
    ledgerClosedAt: new Date('2026-10-25T12:00:00Z'),
    txHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    topics: ['transfer', dummyAccountA, dummyAccountB],
    data: 5000000000n, // 500 tokens in stroops (7 decimals)
    rawXdr: 'AAAA...',
    ...overrides,
  });

  describe('1. LargeTransferDetector (Stateless Rule)', () => {
    const detector = new LargeTransferDetector();

    it('should have standard plugin metadata', () => {
      expect(detector.id).toBe('LARGE_TRANSFER');
      expect(detector.type).toBe('STATELESS');
      expect(detector.name).toContain('Large Transfer');
    });

    it('should trigger alert when SAC transfer amount exceeds threshold', async () => {
      const event = createMockEvent({
        topics: ['transfer', dummyAccountA, dummyAccountB],
        data: 10000000000n, // 10,000 units
      });

      const context: DetectorContext = {
        event,
        ruleParameters: {
          threshold: '5000000000', // 5,000 threshold
        },
      };

      const result = await detector.evaluate(context);
      expect(result).not.toBeNull();
      expect(result?.triggered).toBe(true);
      expect(result?.severity).toBe('HIGH');
      expect(result?.title).toBe('Large Transfer Detected');
      expect(result?.message).toContain('10000000000');
      expect(result?.message).toContain('5000000000');
      expect(result?.metadata.amount).toBe('10000000000');
      expect(result?.metadata.threshold).toBe('5000000000');
      expect(result?.metadata.from).toBe(dummyAccountA);
      expect(result?.metadata.to).toBe(dummyAccountB);
    });

    it('should NOT trigger when amount is exactly equal to threshold', async () => {
      const event = createMockEvent({
        topics: ['transfer', dummyAccountA, dummyAccountB],
        data: 5000000000n,
      });

      const context: DetectorContext = {
        event,
        ruleParameters: {
          threshold: 5000000000n,
        },
      };

      const result = await detector.evaluate(context);
      expect(result).toBeNull();
    });

    it('should NOT trigger when amount is strictly below threshold', async () => {
      const event = createMockEvent({
        topics: ['transfer', dummyAccountA, dummyAccountB],
        data: 1000000000n,
      });

      const context: DetectorContext = {
        event,
        ruleParameters: {
          threshold: '5000000000',
        },
      };

      const result = await detector.evaluate(context);
      expect(result).toBeNull();
    });

    it('should trigger on large 128-bit BigInt amounts without precision loss', async () => {
      // 100 billion tokens with 18 decimals
      const hugeAmount = 100_000_000_000_000_000_000_000_000_000n;
      const threshold = 1_000_000_000_000_000_000_000_000n;

      const event = createMockEvent({
        topics: ['transfer', dummyAccountA, dummyAccountB],
        data: hugeAmount,
      });

      const result = await detector.evaluate({
        event,
        ruleParameters: { threshold: threshold.toString() },
      });

      expect(result?.triggered).toBe(true);
      expect(result?.metadata.amount).toBe(hugeAmount.toString());
      expect(result?.metadata.threshold).toBe(threshold.toString());
    });

    it('should support generic transfer events with data object { amount }', async () => {
      const event = createMockEvent({
        topics: ['Transfer', dummyAccountA],
        data: { amount: 8000000000n, fee: 100n },
      });

      const result = await detector.evaluate({
        event,
        ruleParameters: { threshold: '5000000000' },
      });

      expect(result?.triggered).toBe(true);
      expect(result?.metadata.amount).toBe('8000000000');
    });

    it('should ignore non-transfer events', async () => {
      const event = createMockEvent({
        topics: ['mint', dummyAccountA, dummyAccountB],
        data: 100000000000n,
      });

      const result = await detector.evaluate({
        event,
        ruleParameters: { threshold: '100' },
      });

      expect(result).toBeNull();
    });

    it('should respect custom severity override in ruleParameters', async () => {
      const event = createMockEvent({
        topics: ['transfer', dummyAccountA, dummyAccountB],
        data: 10000000000n,
      });

      const result = await detector.evaluate({
        event,
        ruleParameters: { threshold: '1000', severity: 'CRITICAL' },
      });

      expect(result?.triggered).toBe(true);
      expect(result?.severity).toBe('CRITICAL');
    });
  });

  describe('2. EmergencyPauseDetector (Stateless Rule)', () => {
    const detector = new EmergencyPauseDetector();

    it('should have standard plugin metadata', () => {
      expect(detector.id).toBe('EMERGENCY_PAUSE');
      expect(detector.type).toBe('STATELESS');
      expect(detector.name).toContain('Emergency Pause');
    });

    it('should trigger CRITICAL alert when topic matches "pause"', async () => {
      const event = createMockEvent({
        topics: ['pause', dummyAccountA],
        data: null,
      });

      const result = await detector.evaluate({
        event,
        ruleParameters: {},
      });

      expect(result).not.toBeNull();
      expect(result?.triggered).toBe(true);
      expect(result?.severity).toBe('CRITICAL');
      expect(result?.title).toContain('Emergency Pause Triggered: pause');
      expect(result?.message).toContain(dummyContractId);
      expect(result?.metadata.matchedTopic).toBe('pause');
    });

    it('should trigger on various standard emergency keywords (case-insensitive)', async () => {
      const keywordsToTest = [
        'emergency_pause',
        'EMERGENCY_STOP',
        'Freeze',
        'frozen',
        'circuit_breaker',
        'halt',
        'stop',
      ];

      for (const kw of keywordsToTest) {
        const event = createMockEvent({
          topics: [kw],
        });

        const result = await detector.evaluate({
          event,
          ruleParameters: {},
        });

        expect(result?.triggered).toBe(true);
        expect(result?.severity).toBe('CRITICAL');
      }
    });

    it('should trigger when event.data contains pause action', async () => {
      const event = createMockEvent({
        topics: ['admin_action'],
        data: 'emergency_pause',
      });

      const result = await detector.evaluate({
        event,
        ruleParameters: {},
      });

      expect(result?.triggered).toBe(true);
      expect(result?.metadata.matchedTopic).toBe('emergency_pause');
    });

    it('should support custom pause topics specified in ruleParameters', async () => {
      const event = createMockEvent({
        topics: ['black_swan_shutdown'],
      });

      // Without custom rule parameters, it should not trigger
      const defaultResult = await detector.evaluate({
        event,
        ruleParameters: {},
      });
      expect(defaultResult).toBeNull();

      // With custom pause topics
      const customResult = await detector.evaluate({
        event,
        ruleParameters: {
          pauseTopics: ['black_swan_shutdown', 'kill_switch'],
        },
      });

      expect(customResult?.triggered).toBe(true);
      expect(customResult?.metadata.matchedTopic).toBe('black_swan_shutdown');
    });

    it('should NOT trigger on routine contract calls', async () => {
      const event = createMockEvent({
        topics: ['deposit', dummyAccountA],
        data: 1000n,
      });

      const result = await detector.evaluate({
        event,
        ruleParameters: {},
      });

      expect(result).toBeNull();
    });
  });

  describe('3. DetectorRegistry & Pluggability', () => {
    it('should register defaults and resolve via case-insensitive aliases', () => {
      const registry = new DetectorRegistry();

      expect(registry.get('LARGE_TRANSFER')).toBeDefined();
      expect(registry.get('large_transfer')).toBeDefined();
      expect(registry.get('LARGE_VALUE_TRANSFER')).toBeDefined();

      expect(registry.get('EMERGENCY_PAUSE')).toBeDefined();
      expect(registry.get('emergency_pause_triggered')).toBeDefined();
      expect(registry.get('NON_EXISTENT')).toBeUndefined();
    });

    it('should allow contributors to easily register new custom detector plugins in a single call', async () => {
      const registry = new DetectorRegistry();

      const customBlacklistDetector: DetectorPlugin = {
        id: 'BLACKLIST_INTERACTION',
        name: 'Blacklist Detector',
        description: 'Detects interactions with blacklisted addresses',
        type: 'STATELESS',
        evaluate: async (ctx) => {
          const blacklisted = ctx.ruleParameters.blockedAddress;
          const hasInteraction = ctx.event.topics.includes(blacklisted);
          if (hasInteraction) {
            return {
              triggered: true,
              severity: 'CRITICAL',
              title: 'Blacklist Interaction Detected',
              message: `Address ${blacklisted} interacted with contract ${ctx.event.contractId}`,
              metadata: { blockedAddress: blacklisted },
            };
          }
          return null;
        },
      };

      registry.register(customBlacklistDetector, ['SANCTIONED_ADDRESS']);

      expect(registry.get('BLACKLIST_INTERACTION')).toBe(customBlacklistDetector);
      expect(registry.get('sanctioned_address')).toBe(customBlacklistDetector);

      // Verify execution
      const event = createMockEvent({
        topics: ['transfer', 'G_SANCTIONED_ACCOUNT', dummyAccountB],
      });

      const detector = registry.get('SANCTIONED_ADDRESS');
      const evalResult = await detector?.evaluate({
        event,
        ruleParameters: { blockedAddress: 'G_SANCTIONED_ACCOUNT' },
      });

      expect(evalResult?.triggered).toBe(true);
      expect(evalResult?.title).toBe('Blacklist Interaction Detected');
    });
  });

  describe('4. DetectorRunner Orchestration & Alert Generation', () => {
    it('should orchestrate active rules and dispatch alert payloads', async () => {
      const activeRules: RuleDefinition[] = [
        {
          id: 'rule-1',
          contractId: dummyContractId,
          name: 'Whale Transfer Alert',
          detectorType: 'LARGE_VALUE_TRANSFER',
          severity: 'HIGH',
          parameters: { threshold: '1000000' },
          enabled: true,
        },
        {
          id: 'rule-2',
          contractId: dummyContractId,
          name: 'Protocol Emergency Freeze',
          detectorType: 'EMERGENCY_PAUSE',
          parameters: {},
          enabled: true,
        },
      ];

      const ruleProvider = new InMemoryRuleProvider(activeRules);
      const onAlertSpy = vi.fn();

      const runner = new DetectorRunner({
        ruleProvider,
        onAlert: onAlertSpy,
        network: 'TESTNET',
      });

      // 1. Send transfer event exceeding threshold
      const transferEvent = createMockEvent({
        contractId: dummyContractId,
        topics: ['transfer', dummyAccountA, dummyAccountB],
        data: 50000000n, // 50m > 1m
      });

      const execResults = await runner.evaluateEvent(transferEvent, { persistAlerts: false });

      expect(execResults).toHaveLength(2);
      // rule-1 triggered
      const rule1Result = execResults.find((r) => r.rule.id === 'rule-1');
      expect(rule1Result?.result?.triggered).toBe(true);
      expect(rule1Result?.alertPayload).toBeDefined();
      expect(rule1Result?.alertPayload?.ruleId).toBe('rule-1');
      expect(rule1Result?.alertPayload?.explorerUrl).toBe(
        `https://stellar.expert/explorer/testnet/tx/${transferEvent.txHash}`
      );

      // rule-2 did not trigger on transfer event
      const rule2Result = execResults.find((r) => r.rule.id === 'rule-2');
      expect(rule2Result?.result).toBeNull();

      // onAlert callback fired once
      expect(onAlertSpy).toHaveBeenCalledTimes(1);
      expect(onAlertSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          ruleId: 'rule-1',
          contractId: dummyContractId,
          severity: 'HIGH',
        })
      );
    });

    it('should skip disabled rules', async () => {
      const rules: RuleDefinition[] = [
        {
          id: 'rule-disabled',
          contractId: dummyContractId,
          name: 'Disabled Whale Rule',
          detectorType: 'LARGE_TRANSFER',
          parameters: { threshold: '10' },
          enabled: false,
        },
      ];

      const runner = new DetectorRunner({
        ruleProvider: new InMemoryRuleProvider(rules),
      });

      const event = createMockEvent({ data: 1000000n });
      const results = await runner.evaluateEvent(event, { persistAlerts: false });

      expect(results).toHaveLength(0);
    });

    it('should evaluate a batch of events sequentially', async () => {
      const rules: RuleDefinition[] = [
        {
          id: 'rule-pause',
          contractId: dummyContractId,
          name: 'Pause Watcher',
          detectorType: 'EMERGENCY_PAUSE',
          parameters: {},
          enabled: true,
        },
      ];

      const runner = new DetectorRunner({
        ruleProvider: new InMemoryRuleProvider(rules),
      });

      const events = [
        createMockEvent({ id: 'evt-1', topics: ['deposit'] }),
        createMockEvent({ id: 'evt-2', topics: ['pause'] }),
        createMockEvent({ id: 'evt-3', topics: ['withdraw'] }),
      ];

      const batchResults = await runner.evaluateBatch(events, { persistAlerts: false });
      expect(batchResults).toHaveLength(3);

      const triggeredResults = batchResults.filter((r) => r.result?.triggered);
      expect(triggeredResults).toHaveLength(1);
      expect(triggeredResults[0].alertPayload?.title).toContain('Emergency Pause Triggered');
    });

    it('should gracefully handle unexpected detector evaluation errors without crashing', async () => {
      const registry = new DetectorRegistry();
      const faultyDetector: DetectorPlugin = {
        id: 'FAULTY_DETECTOR',
        name: 'Faulty',
        description: 'Always throws',
        type: 'STATELESS',
        evaluate: async () => {
          throw new Error('Simulation of catastrophic detector plugin crash');
        },
      };
      registry.register(faultyDetector);

      const runner = new DetectorRunner({ registry });
      const event = createMockEvent();

      const results = await runner.evaluateEvent(event, {
        rules: [
          {
            id: 'faulty-rule',
            contractId: dummyContractId,
            name: 'Faulty Rule',
            detectorType: 'FAULTY_DETECTOR',
            parameters: {},
            enabled: true,
          },
        ],
        persistAlerts: false,
      });

      expect(results).toHaveLength(1);
      expect(results[0].error).toContain('Simulation of catastrophic detector plugin crash');
      expect(results[0].result).toBeNull();
    });

    it('should correctly build explorer URLs for testnet and mainnet', () => {
      const hash = 'abcdef123456';
      expect(buildExplorerUrl(hash, 'TESTNET')).toBe('https://stellar.expert/explorer/testnet/tx/abcdef123456');
      expect(buildExplorerUrl(hash, 'MAINNET')).toBe('https://stellar.expert/explorer/public/tx/abcdef123456');
      expect(buildExplorerUrl('')).toBe('');
    });
  });

  describe('5. RapidDrainDetector (Windowed Rule)', () => {
    const detector = new RapidDrainDetector();

    it('should have standard plugin metadata', () => {
      expect(detector.id).toBe('RAPID_DRAIN');
      expect(detector.type).toBe('WINDOWED');
      expect(detector.name).toContain('Rapid Drain');
    });

    it('should trigger alert when cumulative volume exceeds fixed threshold over sliding window', async () => {
      const historyProvider = new InMemoryEventHistoryProvider();
      const now = new Date();

      // Seed historical transfer events in the last 2 minutes (cumulative 8,000,000,000)
      historyProvider.recordEvent(
        createMockEvent({
          id: 'hist-1',
          ledgerClosedAt: new Date(now.getTime() - 60 * 1000),
          topics: ['transfer', dummyAccountA, dummyAccountB],
          data: 5_000_000_000n,
        })
      );
      historyProvider.recordEvent(
        createMockEvent({
          id: 'hist-2',
          ledgerClosedAt: new Date(now.getTime() - 30 * 1000),
          topics: ['transfer', dummyAccountA, dummyAccountB],
          data: 3_000_000_000n,
        })
      );

      // Current event: 3,000,000,000 -> cumulative 11,000,000,000 (exceeds 10,000,000,000)
      const currentEvent = createMockEvent({
        id: 'curr-1',
        ledgerClosedAt: now,
        topics: ['transfer', dummyAccountA, dummyAccountB],
        data: 3_000_000_000n,
      });

      const context: DetectorContext = {
        event: currentEvent,
        ruleParameters: {
          threshold: '10000000000', // 10B limit
          windowSeconds: 300,
        },
        eventHistoryProvider: historyProvider,
      };

      const result = await detector.evaluate(context);
      expect(result).not.toBeNull();
      expect(result?.triggered).toBe(true);
      expect(result?.title).toContain('Rapid Liquidity Drain');
      expect(result?.metadata.cumulativeVolume).toBe('11000000000');
      expect(result?.metadata.currentEventAmount).toBe('3000000000');
      expect(result?.metadata.historicalVolume).toBe('8000000000');
      expect(result?.metadata.windowSeconds).toBe(300);
      expect(result?.metadata.velocityPerSecond).toBeCloseTo(11000000000 / 300);
    });

    it('should trigger alert when rolling outflow drains percentage threshold of baseline reserve', async () => {
      const historyProvider = new InMemoryEventHistoryProvider();
      const now = new Date();

      // 25,000,000,000 historical volume
      historyProvider.recordEvent(
        createMockEvent({
          id: 'hist-drain-1',
          ledgerClosedAt: new Date(now.getTime() - 40 * 1000),
          topics: ['transfer'],
          data: 25_000_000_000n,
        })
      );

      // Current event: 5,000,000,000 -> total 30,000,000,000 = 30% of 100,000,000,000 reserve
      const currentEvent = createMockEvent({
        id: 'curr-drain-1',
        ledgerClosedAt: now,
        topics: ['transfer'],
        data: 5_000_000_000n,
      });

      const context: DetectorContext = {
        event: currentEvent,
        ruleParameters: {
          baselineReserve: '100000000000', // 100B TVL reserve
          maxDrainPercent: 25, // 25% max drain
          windowMinutes: 5,
        },
        eventHistoryProvider: historyProvider,
      };

      const result = await detector.evaluate(context);
      expect(result).not.toBeNull();
      expect(result?.triggered).toBe(true);
      expect(result?.message).toContain('30.00%');
      expect(result?.metadata.calculatedDrainPercent).toBe(30);
    });

    it('should NOT trigger when cumulative volume is below configured threshold', async () => {
      const historyProvider = new InMemoryEventHistoryProvider();
      const currentEvent = createMockEvent({
        topics: ['transfer'],
        data: 1_000_000_000n,
      });

      const context: DetectorContext = {
        event: currentEvent,
        ruleParameters: {
          threshold: '10000000000', // 10B threshold vs 1B current
          windowSeconds: 300,
        },
        eventHistoryProvider: historyProvider,
      };

      const result = await detector.evaluate(context);
      expect(result).toBeNull();
    });
  });

  describe('6. FailedTxBurstDetector (Windowed Rule)', () => {
    const detector = new FailedTxBurstDetector();

    it('should have standard plugin metadata', () => {
      expect(detector.id).toBe('FAILED_TX_BURST');
      expect(detector.type).toBe('WINDOWED');
      expect(detector.name).toContain('Failed Transaction Burst');
    });

    it('should trigger alert when failure burst count exceeds threshold within sliding window', async () => {
      const historyProvider = new InMemoryEventHistoryProvider();
      const now = new Date();

      // Seed 4 historical failed events in the last 30s
      historyProvider.recordFailedEvent(dummyContractId, new Date(now.getTime() - 25 * 1000));
      historyProvider.recordFailedEvent(dummyContractId, new Date(now.getTime() - 20 * 1000));
      historyProvider.recordFailedEvent(dummyContractId, new Date(now.getTime() - 15 * 1000));
      historyProvider.recordFailedEvent(dummyContractId, new Date(now.getTime() - 10 * 1000));

      // 5th failure: current diagnostic revert event
      const currentEvent = createMockEvent({
        id: 'curr-fail-1',
        type: 'diagnostic',
        topics: ['error', 'panic', 'HostError'],
        data: { error: 'Simulation revert: arithmetic underflow' },
        ledgerClosedAt: now,
      });

      const context: DetectorContext = {
        event: currentEvent,
        ruleParameters: {
          burstThreshold: 5,
          windowSeconds: 60,
        },
        eventHistoryProvider: historyProvider,
      };

      const result = await detector.evaluate(context);
      expect(result).not.toBeNull();
      expect(result?.triggered).toBe(true);
      expect(result?.title).toContain('Exploit Probe Detected');
      expect(result?.metadata.failureCount).toBe(5);
      expect(result?.metadata.burstThreshold).toBe(5);
      expect(result?.metadata.ratePerMinute).toBe(5);
      expect(result?.metadata.isCurrentEventFailure).toBe(true);
    });

    it('should NOT trigger when failure count is below threshold', async () => {
      const historyProvider = new InMemoryEventHistoryProvider();
      historyProvider.recordFailedEvent(dummyContractId, new Date());

      const currentEvent = createMockEvent({
        type: 'diagnostic',
        topics: ['error'],
      });

      const context: DetectorContext = {
        event: currentEvent,
        ruleParameters: {
          burstThreshold: 5,
          windowSeconds: 60,
        },
        eventHistoryProvider: historyProvider,
      };

      const result = await detector.evaluate(context);
      expect(result).toBeNull();
    });
  });

  describe('7. EventHistoryProvider Implementations', () => {
    it('should correctly filter and sum events in window with InMemoryEventHistoryProvider', async () => {
      const provider = new InMemoryEventHistoryProvider();
      const now = new Date();

      // Recent event inside 60s window
      provider.recordEvent(
        createMockEvent({
          id: 'recent-1',
          contractId: dummyContractId,
          ledgerClosedAt: new Date(now.getTime() - 10 * 1000),
          topics: ['transfer'],
          data: 2_000_000_000n,
        })
      );

      // Old event outside 60s window
      provider.recordEvent(
        createMockEvent({
          id: 'old-1',
          contractId: dummyContractId,
          ledgerClosedAt: new Date(now.getTime() - 120 * 1000),
          topics: ['transfer'],
          data: 50_000_000_000n,
        })
      );

      const eventsInWindow = await provider.getEventsInWindow(dummyContractId, 60);
      expect(eventsInWindow).toHaveLength(1);
      expect(eventsInWindow[0].id).toBe('recent-1');

      const totalVolume = await provider.getAggregateVolume(dummyContractId, 60, 'transfer');
      expect(totalVolume).toBe(2_000_000_000n);
    });

    it('should query Prisma PostgreSQL mirror with DatabaseEventHistoryProvider', async () => {
      const mockPrisma = {
        event: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: 'db-evt-1',
              contractId: dummyContractId,
              type: 'contract',
              ledger: 100n,
              ledgerClosedAt: new Date(),
              txHash: 'tx1',
              topics: ['transfer'],
              data: 4_000_000_000n,
              rawXdr: 'raw',
            },
          ]),
        },
        failedEvent: {
          count: vi.fn().mockResolvedValue(7),
        },
      } as any;

      const provider = new DatabaseEventHistoryProvider(mockPrisma);
      const volume = await provider.getAggregateVolume(dummyContractId, 300);
      expect(volume).toBe(4_000_000_000n);

      const failedCount = await provider.getFailedEventCountInWindow(dummyContractId, 60);
      expect(failedCount).toBe(7);
      expect(mockPrisma.failedEvent.count).toHaveBeenCalledWith({
        where: {
          contractId: dummyContractId,
          createdAt: { gte: expect.any(Date) },
        },
      });
    });
  });

  describe('8. DetectorRunner Windowed Rule Orchestration', () => {
    it('should evaluate registered RAPID_DRAIN and FAILED_TX_BURST rules via DetectorRunner', async () => {
      const historyProvider = new InMemoryEventHistoryProvider();
      const now = new Date();

      historyProvider.recordEvent(
        createMockEvent({
          id: 'hist-e2e',
          ledgerClosedAt: new Date(now.getTime() - 30 * 1000),
          topics: ['transfer'],
          data: 10_000_000_000n,
        })
      );

      const runner = new DetectorRunner({
        eventHistoryProvider: historyProvider,
      });

      const currentEvent = createMockEvent({
        id: 'curr-e2e',
        ledgerClosedAt: now,
        topics: ['transfer'],
        data: 5_000_000_000n,
      });

      const results = await runner.evaluateEvent(currentEvent, {
        rules: [
          {
            id: 'rule-rapid-drain',
            contractId: dummyContractId,
            name: 'Rapid Drain Rule',
            detectorType: 'RAPID_DRAIN',
            parameters: { threshold: '12000000000', windowSeconds: 300 },
            enabled: true,
          },
        ],
        persistAlerts: false,
      });

      expect(results).toHaveLength(1);
      expect(results[0].result?.triggered).toBe(true);
      expect(results[0].alertPayload?.title).toBe('Rapid Liquidity Drain Detected');
      expect(results[0].alertPayload?.metadata.cumulativeVolume).toBe('15000000000');
    });
  });
});
