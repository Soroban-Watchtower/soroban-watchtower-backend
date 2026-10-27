import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

import { config } from '../config/env.js';
import { logger } from '../observability/logger.js';
import { metrics, httpRequestsTotal, httpRequestDuration } from '../observability/metrics.js';
import { requestIdPlugin } from '../observability/requestId.js';
import { handleFastifyError } from './errorHandlers.js';

import { healthRoutes } from './healthRoutes.js';
import { contractRoutes } from './routes/contracts.js';
import { ruleRoutes } from './routes/rules.js';
import { channelRoutes } from './routes/channels.js';
import { alertRoutes } from './routes/alerts.js';
import { telemetryRoutes } from './routes/telemetry.js';
import { failedEventRoutes } from './routes/failedEvents.js';
import { eventRoutes } from './routes/events.js';

export interface ServerOptions {
  enableLogging?: boolean;
}

/**
 * Builds and configures the production Fastify application instance.
 */
export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance<any, any, any, any>> {
  const fastify = Fastify({
    logger: options.enableLogging ? (logger as any) : false,
    disableRequestLogging: !options.enableLogging,
    ajv: {
      customOptions: {
        coerceTypes: 'array',
        removeAdditional: 'all',
      },
    },
  });

  // 1. Core Security & Middleware Plugins
  await fastify.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  await fastify.register(helmet, {
    contentSecurityPolicy: false, // Allows Swagger UI to load resources
  });

  await fastify.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
  });

  await fastify.register(requestIdPlugin);

  // 2. OpenAPI / Swagger Documentation
  await fastify.register(swagger, {
    openapi: {
      info: {
        title: 'Soroban Watchdog REST API',
        description:
          'High-performance telemetry, anomaly surveillance, and exploit-alerting engine for Stellar Soroban smart contracts',
        version: '0.1.0',
      },
      servers: [{ url: `http://localhost:${config.PORT}` }],
      tags: [
        { name: 'Health', description: 'System health, liveness, and readiness probes' },
        { name: 'Contracts', description: 'Monitored Soroban contract management' },
        { name: 'Rules', description: 'Detector rule definitions & parameter configuration' },
        { name: 'Channels', description: 'Notification destinations (Discord, Telegram, Webhook)' },
        { name: 'Alerts', description: 'Triggered security alerts and delivery logs' },
        { name: 'Telemetry', description: 'Zero-chain-roundtrip contract telemetry & frequency metrics' },
        { name: 'Events', description: 'Historical contract telemetry events and decoded logs' },
        { name: 'FailedEvents', description: 'Dead-letter quarantine inspection and recovery' },
      ],
    },
  });

  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  });

  // 3. Prometheus Observability Metrics Endpoint & Request Telemetry Hooks
  const requestStartTimes = new WeakMap<any, number>();

  fastify.addHook('onRequest', async (request) => {
    requestStartTimes.set(request, performance.now());
  });

  fastify.addHook('onResponse', async (request, reply) => {
    const startTime = requestStartTimes.get(request);
    if (startTime) {
      const durationSeconds = (performance.now() - startTime) / 1000;
      const routePath = request.routeOptions?.url || request.url.split('?')[0];

      httpRequestsTotal.inc({
        method: request.method,
        route: routePath,
        status_code: reply.statusCode,
      });

      httpRequestDuration.observe(durationSeconds, {
        method: request.method,
        route: routePath,
      });
    }
  });

  fastify.get('/metrics', async (_request, reply) => {
    const serializedMetrics = metrics.exportMetrics();
    return reply
      .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
      .status(200)
      .send(serializedMetrics);
  });

  // 4. Centralized RFC 7807 Error and 404 Handlers
  fastify.setErrorHandler(handleFastifyError);
  fastify.setNotFoundHandler((request, reply) => {
    reply.status(404).header('Content-Type', 'application/problem+json').send({
      type: 'https://soroban-watchdog.io/errors/resource-not-found',
      title: 'Not Found',
      status: 404,
      detail: `Route ${request.method} ${request.url} not found.`,
      instance: request.url,
      timestamp: new Date().toISOString(),
    });
  });

  // 5. Register Subsystem Routes
  await fastify.register(healthRoutes);
  await fastify.register(contractRoutes);
  await fastify.register(ruleRoutes);
  await fastify.register(channelRoutes);
  await fastify.register(alertRoutes);
  await fastify.register(telemetryRoutes);
  await fastify.register(eventRoutes);
  await fastify.register(failedEventRoutes);

  return fastify;
}
