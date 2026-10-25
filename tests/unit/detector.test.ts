import { describe, it, expect, vi } from 'vitest';
import {
  LargeTransferDetector,
  EmergencyPauseDetector,
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
});
