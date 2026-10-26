import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/server/server.js';
import { REQUEST_ID_HEADER } from '../../src/observability/requestId.js';

describe('Fastify REST API Server & Health Routes (src/server)', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await buildServer({ enableLogging: false });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it('should respond with 200 OK on /healthz', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/healthz',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('ok');
    expect(body.service).toBe('soroban-watchdog-backend');
    expect(typeof body.uptime).toBe('number');
  });

  it('should respond with 200 OK on /livez with memory stats', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/livez',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('alive');
    expect(body.memory).toBeDefined();
    expect(typeof body.memory.heapUsedMb).toBe('number');
  });

  it('should expose Prometheus metrics on /metrics with proper content-type', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/metrics',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('# HELP');
    expect(response.body).toContain('# TYPE');
  });

  it('should inject and propagate correlation request ID header', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/healthz',
    });

    const header = response.headers[REQUEST_ID_HEADER];
    expect(header).toBeDefined();
    expect(typeof header).toBe('string');
    expect(header).toMatch(/^req_/);
  });

  it('should preserve incoming x-request-id if supplied by client', async () => {
    const customId = 'client-provided-correlation-id-999';
    const response = await server.inject({
      method: 'GET',
      url: '/healthz',
      headers: {
        [REQUEST_ID_HEADER]: customId,
      },
    });

    expect(response.headers[REQUEST_ID_HEADER]).toBe(customId);
  });

  it('should format 404 responses according to RFC 7807 Problem Details', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/non-existent-route',
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    const body = JSON.parse(response.body);
    expect(body.status).toBe(404);
    expect(body.title).toBe('Not Found');
    expect(body.instance).toBe('/non-existent-route');
  });
});
