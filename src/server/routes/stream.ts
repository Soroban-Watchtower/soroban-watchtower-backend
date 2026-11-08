import crypto from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { getStreamBus, StreamBus } from '../streaming/streamBus.js';
import { requireAuth } from '../auth/apiKeyAuth.js';
import { Severity } from '../../types/index.js';

export interface StreamRouteOptions {
  streamBus?: StreamBus;
}

export async function streamRoutes(
  fastify: FastifyInstance,
  options: StreamRouteOptions = {}
): Promise<void> {
  const streamBus = options.streamBus || getStreamBus();

  // 1. Real-time Security Alerts Stream (SSE)
  fastify.get(
    '/api/v1/stream/alerts',
    {
      preHandler: [requireAuth({ scopes: ['read:alerts'] })],
    },
    async (request, reply) => {
      const query = request.query as {
        contractId?: string;
        severity?: Severity;
        autoClose?: boolean | string;
      };

      const clientId = `client_${crypto.randomBytes(8).toString('hex')}`;

      // Set standard Server-Sent Events headers
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      // Send initial connection handshake
      reply.raw.write(
        StreamBus.formatSseFrame('connected', {
          clientId,
          stream: 'alerts',
          filters: { contractId: query.contractId, severity: query.severity },
          timestamp: new Date().toISOString(),
        })
      );

      if (query.autoClose === 'true' || query.autoClose === true) {
        reply.raw.end();
        return;
      }

      // Keep-alive heartbeat every 15 seconds
      const heartbeatInterval = setInterval(() => {
        if (!reply.raw.writableEnded) {
          reply.raw.write(': keepalive\n\n');
        }
      }, 15000);

      // Subscribe to alert bus
      const unsubscribe = streamBus.subscribeAlerts(
        (alert) => {
          if (!reply.raw.writableEnded) {
            reply.raw.write(StreamBus.formatSseFrame('alert', alert, alert.alertId));
          }
        },
        {
          contractId: query.contractId,
          severity: query.severity,
        }
      );

      // Clean up resources upon client disconnect
      const cleanup = () => {
        clearInterval(heartbeatInterval);
        unsubscribe();
      };

      request.raw.on('close', cleanup);
      request.raw.on('error', cleanup);
    }
  );

  // 2. Real-time Decoded Contract Events Stream (SSE)
  fastify.get(
    '/api/v1/stream/events',
    {
      preHandler: [requireAuth({ scopes: ['read:events'] })],
    },
    async (request, reply) => {
      const query = request.query as {
        contractId?: string;
        eventType?: string;
        autoClose?: boolean | string;
      };

      const clientId = `client_${crypto.randomBytes(8).toString('hex')}`;

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      reply.raw.write(
        StreamBus.formatSseFrame('connected', {
          clientId,
          stream: 'events',
          filters: { contractId: query.contractId, eventType: query.eventType },
          timestamp: new Date().toISOString(),
        })
      );

      if (query.autoClose === 'true' || query.autoClose === true) {
        reply.raw.end();
        return;
      }

      const heartbeatInterval = setInterval(() => {
        if (!reply.raw.writableEnded) {
          reply.raw.write(': keepalive\n\n');
        }
      }, 15000);

      const unsubscribe = streamBus.subscribeEvents(
        (event) => {
          if (!reply.raw.writableEnded) {
            reply.raw.write(StreamBus.formatSseFrame('contract_event', event, event.id));
          }
        },
        {
          contractId: query.contractId,
          eventType: query.eventType,
        }
      );

      const cleanup = () => {
        clearInterval(heartbeatInterval);
        unsubscribe();
      };

      request.raw.on('close', cleanup);
      request.raw.on('error', cleanup);
    }
  );

  // 3. Real-time Telemetry Pulse Stream (SSE)
  fastify.get(
    '/api/v1/stream/telemetry',
    {
      preHandler: [requireAuth({ scopes: ['read:telemetry'] })],
    },
    async (request, reply) => {
      const query = request.query as {
        contractId?: string;
        autoClose?: boolean | string;
      };
      const clientId = `client_${crypto.randomBytes(8).toString('hex')}`;

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      reply.raw.write(
        StreamBus.formatSseFrame('connected', {
          clientId,
          stream: 'telemetry',
          filters: { contractId: query.contractId },
          timestamp: new Date().toISOString(),
        })
      );

      if (query.autoClose === 'true' || query.autoClose === true) {
        reply.raw.end();
        return;
      }

      const heartbeatInterval = setInterval(() => {
        if (!reply.raw.writableEnded) {
          reply.raw.write(': keepalive\n\n');
        }
      }, 15000);

      const unsubscribe = streamBus.subscribeTelemetry(
        (telemetryData) => {
          if (!reply.raw.writableEnded) {
            reply.raw.write(StreamBus.formatSseFrame('telemetry', telemetryData));
          }
        },
        { contractId: query.contractId }
      );

      const cleanup = () => {
        clearInterval(heartbeatInterval);
        unsubscribe();
      };

      request.raw.on('close', cleanup);
      request.raw.on('error', cleanup);
    }
  );

  // 4. Stream Bus Telemetry & Connection Stats (JSON)
  fastify.get(
    '/api/v1/stream/stats',
    {
      preHandler: [requireAuth({ scopes: ['read:telemetry'] })],
    },
    async (_request, reply) => {
      return reply.send({ data: streamBus.getStats() });
    }
  );
}
