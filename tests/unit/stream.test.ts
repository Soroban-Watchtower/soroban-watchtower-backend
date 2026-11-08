import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { StreamBus } from '../../src/server/streaming/streamBus.js';
import { buildServer } from '../../src/server/server.js';
import { AlertPayload, DecodedSorobanEvent } from '../../src/types/index.js';

describe('Real-Time Streaming Bus & Server-Sent Events (SSE) (src/server/streaming)', () => {
  let streamBus: StreamBus;

  beforeAll(() => {
    streamBus = new StreamBus();
  });

  describe('StreamBus Core In-Memory Engine', () => {
    it('should format standard W3C compliant SSE frames', () => {
      const frame = StreamBus.formatSseFrame('alert', { title: 'Test Alert' }, 'alert-123');
      expect(frame).toBe(
        'id: alert-123\nevent: alert\ndata: {"title":"Test Alert"}\n\n'
      );
    });

    it('should format SSE frames without ID when not provided', () => {
      const frame = StreamBus.formatSseFrame('ping', { ok: true });
      expect(frame).toBe('event: ping\ndata: {"ok":true}\n\n');
    });

    it('should broadcast alerts and respect contractId and severity filters', () => {
      const receivedAlerts: AlertPayload[] = [];

      const unsubscribe = streamBus.subscribeAlerts(
        (alert) => {
          receivedAlerts.push(alert);
        },
        {
          contractId: 'C_TARGET_CONTRACT',
          severity: 'CRITICAL',
        }
      );

      // Alert 1: Matching both contractId and severity
      const alertMatch: AlertPayload = {
        alertId: 'alert-1',
        contractId: 'C_TARGET_CONTRACT',
        ruleId: 'rule-1',
        severity: 'CRITICAL',
        title: 'Exploit In Progress',
        message: 'Rapid drain detected',
        timestamp: new Date(),
        metadata: {},
        explorerUrl: 'https://stellar.expert/explorer/testnet/tx/1',
      };

      // Alert 2: Non-matching contractId
      const alertWrongContract: AlertPayload = {
        ...alertMatch,
        alertId: 'alert-2',
        contractId: 'C_OTHER_CONTRACT',
      };

      // Alert 3: Non-matching severity
      const alertWrongSeverity: AlertPayload = {
        ...alertMatch,
        alertId: 'alert-3',
        severity: 'LOW',
      };

      streamBus.publishAlert(alertMatch);
      streamBus.publishAlert(alertWrongContract);
      streamBus.publishAlert(alertWrongSeverity);

      expect(receivedAlerts).toHaveLength(1);
      expect(receivedAlerts[0].alertId).toBe('alert-1');

      unsubscribe();
    });

    it('should broadcast contract events and respect eventType filters', () => {
      const receivedEvents: DecodedSorobanEvent[] = [];

      const unsubscribe = streamBus.subscribeEvents(
        (event) => {
          receivedEvents.push(event);
        },
        {
          eventType: 'contract',
        }
      );

      const contractEvent: DecodedSorobanEvent = {
        id: '100-1-0',
        contractId: 'C_TEST',
        type: 'contract',
        ledger: 100n,
        ledgerClosedAt: new Date(),
        txHash: 'hash-1',
        topics: ['transfer'],
        data: { amount: 500 },
        rawXdr: 'AAAA',
      };

      const systemEvent: DecodedSorobanEvent = {
        ...contractEvent,
        id: '100-1-1',
        type: 'system',
      };

      streamBus.publishEvent(contractEvent);
      streamBus.publishEvent(systemEvent);

      expect(receivedEvents).toHaveLength(1);
      expect(receivedEvents[0].id).toBe('100-1-0');

      unsubscribe();
    });

    it('should broadcast telemetry pulses to subscribers', () => {
      const receivedTelemetry: any[] = [];

      const unsubscribe = streamBus.subscribeTelemetry((telemetry) => {
        receivedTelemetry.push(telemetry);
      });

      streamBus.publishTelemetry('C_TEST', { totalTps: 15.5 });

      expect(receivedTelemetry).toHaveLength(1);
      expect(receivedTelemetry[0].contractId).toBe('C_TEST');
      expect(receivedTelemetry[0].telemetry.totalTps).toBe(15.5);

      unsubscribe();
    });

    it('should accurately track active connections and decrements on unsubscribe', () => {
      const statsBefore = streamBus.getStats();
      const unsub1 = streamBus.subscribeAlerts(() => {});
      const unsub2 = streamBus.subscribeEvents(() => {});

      const statsDuring = streamBus.getStats();
      expect(statsDuring.totalConnections).toBe(statsBefore.totalConnections + 2);

      unsub1();
      unsub2();

      const statsAfter = streamBus.getStats();
      expect(statsAfter.totalConnections).toBe(statsBefore.totalConnections);
    });
  });

  describe('Fastify SSE Streaming HTTP Pipeline', () => {
    let server: FastifyInstance;
    let customBus: StreamBus;

    beforeAll(async () => {
      customBus = new StreamBus();
      server = await buildServer({
        enableLogging: false,
        streamBus: customBus,
      });
      await server.ready();
    });

    afterAll(async () => {
      await server.close();
    });

    it('should establish an SSE stream on GET /api/v1/stream/alerts with proper handshake', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/stream/alerts?autoClose=true',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('text/event-stream');
      expect(response.headers['cache-control']).toContain('no-cache');
      expect(response.headers['connection']).toBe('keep-alive');

      // First chunk contains connected greeting event
      expect(response.body).toContain('event: connected');
      expect(response.body).toContain('"stream":"alerts"');
    });

    it('should establish an SSE stream on GET /api/v1/stream/events with proper handshake', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/stream/events?contractId=C_SAMPLE&autoClose=true',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('text/event-stream');
      expect(response.body).toContain('event: connected');
      expect(response.body).toContain('"contractId":"C_SAMPLE"');
    });

    it('should return connection statistics via GET /api/v1/stream/stats', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/stream/stats',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toBeDefined();
      expect(typeof body.data.totalConnections).toBe('number');
    });
  });
});
