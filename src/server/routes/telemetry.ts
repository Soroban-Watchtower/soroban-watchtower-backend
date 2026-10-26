import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db/client.js';
import { createCursorManager } from '../../ingest/cursorManager.js';
import { summarizeTelemetry, calculateVolumeVelocity, calculateFrequency } from '../../lib/domainMath.js';

export const telemetryRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  const cursorManager = createCursorManager();

  // Get real-time zero-chain-roundtrip telemetry metrics for a contract
  fastify.get('/api/v1/telemetry/:contractId', async (request, reply) => {
    const { contractId } = request.params as { contractId: string };
    const query = z
      .object({
        windowSeconds: z.coerce.number().int().positive().default(300),
      })
      .parse(request.query);

    const contract = await prisma.contract.findUnique({
      where: { id: contractId },
    });

    if (!contract) {
      return reply.status(404).send({ error: `Contract '${contractId}' not found` });
    }

    const windowStart = new Date(Date.now() - query.windowSeconds * 1000);

    // Query recent events from PostgreSQL mirror
    const [recentEvents, lagInfo, totalEventsCount] = await Promise.all([
      prisma.event.findMany({
        where: {
          contractId,
          ledgerClosedAt: { gte: windowStart },
        },
        orderBy: { ledgerClosedAt: 'desc' },
      }),
      cursorManager.getLag(contractId),
      prisma.event.count({ where: { contractId } }),
    ]);

    const summary = summarizeTelemetry(
      contractId,
      recentEvents,
      lagInfo?.lag || 0n,
      query.windowSeconds
    );

    return {
      data: {
        ...summary,
        lifetimeTotalEvents: totalEventsCount,
        windowSeconds: query.windowSeconds,
        windowEventCount: recentEvents.length,
        currentLagLedgers: Number(lagInfo?.lag || 0n),
        isSynced: lagInfo?.isSynced ?? false,
      },
    };
  });
};
