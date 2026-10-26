import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { prisma } from '../db/client.js';
import { createCursorManager } from '../ingest/cursorManager.js';

export const healthRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  const cursorManager = createCursorManager();

  /**
   * Basic process health check.
   */
  fastify.get('/healthz', async (_request, reply) => {
    return reply.status(200).send({
      status: 'ok',
      service: 'soroban-watchdog-backend',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * Kubernetes Liveness Probe: Verifies process is responsive and not deadlocked.
   */
  fastify.get('/livez', async (_request, reply) => {
    const memory = process.memoryUsage();
    return reply.status(200).send({
      status: 'alive',
      uptimeSeconds: Math.floor(process.uptime()),
      memory: {
        heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
        rssMb: Math.round(memory.rss / 1024 / 1024),
      },
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * Kubernetes Readiness Probe: Verifies database connectivity and calculates poller lag.
   */
  fastify.get('/readyz', async (_request, reply) => {
    const checks: Record<string, { status: 'healthy' | 'unhealthy'; error?: string; latencyMs?: number }> = {};
    let isReady = true;

    // 1. PostgreSQL Database Connectivity Check
    const dbStart = performance.now();
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = {
        status: 'healthy',
        latencyMs: Math.round(performance.now() - dbStart),
      };
    } catch (err: any) {
      isReady = false;
      checks.database = {
        status: 'unhealthy',
        error: err.message,
      };
    }

    // 2. Ingestion Lag Status Check
    try {
      const activeContracts = await prisma.contract.findMany({
        where: { active: true },
        select: { id: true },
        take: 5,
      });

      let maxLag = 0n;
      for (const c of activeContracts) {
        const lagInfo = await cursorManager.getLag(c.id);
        if (lagInfo && lagInfo.lag > maxLag) {
          maxLag = lagInfo.lag;
        }
      }

      checks.poller = {
        status: 'healthy',
        latencyMs: Number(maxLag),
      };
    } catch (pollerErr: any) {
      checks.poller = {
        status: 'unhealthy',
        error: pollerErr.message,
      };
    }

    const statusCode = isReady ? 200 : 503;
    return reply.status(statusCode).send({
      status: isReady ? 'ready' : 'not_ready',
      checks,
      timestamp: new Date().toISOString(),
    });
  });
};
