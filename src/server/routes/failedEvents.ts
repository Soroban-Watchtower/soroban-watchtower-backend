import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db/client.js';
import { createFailedEventManager } from '../../ingest/failedEventManager.js';
import { decodeSorobanEvent } from '../../decoder/eventDecoder.js';
import { createCursorManager } from '../../ingest/cursorManager.js';

export const failedEventRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  const failedManager = createFailedEventManager();
  const cursorManager = createCursorManager();

  // List dead-letter failed events
  fastify.get('/api/v1/failed-events', async (request) => {
    const query = z
      .object({
        status: z.enum(['PENDING', 'RESOLVED', 'DISCARDED']).optional(),
        contractId: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(request.query);

    const where = {
      status: query.status,
      contractId: query.contractId,
    };

    const [total, items] = await Promise.all([
      prisma.failedEvent.count({ where }),
      prisma.failedEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        skip: query.offset,
      }),
    ]);

    return {
      data: items,
      meta: {
        total,
        limit: query.limit,
        offset: query.offset,
        hasMore: query.offset + items.length < total,
      },
    };
  });

  // Replay a specific failed event
  fastify.post('/api/v1/failed-events/:id/replay', async (request, reply) => {
    const { id } = request.params as { id: string };

    const item = await prisma.failedEvent.findUnique({ where: { id } });
    if (!item) {
      return reply.status(404).send({ error: `Failed event '${id}' not found` });
    }

    try {
      const decoded = decodeSorobanEvent(item.rawPayload as any, { contractId: item.contractId });

      await cursorManager.saveEventsAndCursor(
        item.contractId,
        [decoded],
        decoded.id,
        decoded.ledger
      );

      const resolved = await failedManager.markResolved(id);
      return reply.status(200).send({
        status: 'success',
        message: `Successfully reprocessed event ${decoded.id}`,
        data: resolved,
      });
    } catch (err: any) {
      const updated = await failedManager.recordReplayFailure(id, err);
      return reply.status(422).send({
        status: 'failed',
        error: `Replay failed: ${err.message}`,
        data: updated,
      });
    }
  });

  // Discard a failed event
  fastify.post('/api/v1/failed-events/:id/discard', async (request, reply) => {
    const { id } = request.params as { id: string };
    const discarded = await failedManager.markDiscarded(id);
    return reply.status(200).send({ status: 'discarded', data: discarded });
  });
};
