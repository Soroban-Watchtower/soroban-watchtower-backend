import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db/client.js';

const eventQuerySchema = z.object({
  contractId: z.string().optional(),
  type: z.string().optional(),
  ledger: z.coerce.number().optional(),
  fromLedger: z.coerce.number().optional(),
  toLedger: z.coerce.number().optional(),
  txHash: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const eventRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // GET /api/v1/events: Query historical telemetry events with pagination and filters
  fastify.get('/api/v1/events', async (request) => {
    const query = eventQuerySchema.parse(request.query);

    const where: any = {};
    if (query.contractId) where.contractId = query.contractId;
    if (query.type) where.type = query.type;
    if (query.txHash) where.txHash = query.txHash;

    if (query.ledger !== undefined) {
      where.ledger = BigInt(query.ledger);
    } else if (query.fromLedger !== undefined || query.toLedger !== undefined) {
      where.ledger = {};
      if (query.fromLedger !== undefined) where.ledger.gte = BigInt(query.fromLedger);
      if (query.toLedger !== undefined) where.ledger.lte = BigInt(query.toLedger);
    }

    const [total, events] = await Promise.all([
      prisma.event.count({ where }),
      prisma.event.findMany({
        where,
        include: {
          contract: { select: { id: true, name: true, network: true } },
        },
        orderBy: { ledgerClosedAt: 'desc' },
        take: query.limit,
        skip: query.offset,
      }),
    ]);

    // Format BigInt ledger values to string to guarantee valid JSON serialization
    const serializedEvents = events.map((event) => ({
      ...event,
      ledger: event.ledger.toString(),
    }));

    return {
      data: serializedEvents,
      meta: {
        total,
        limit: query.limit,
        offset: query.offset,
        hasMore: query.offset + events.length < total,
      },
    };
  });

  // GET /api/v1/events/:id: Retrieve single event by ID
  fastify.get('/api/v1/events/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const event = await prisma.event.findUnique({
      where: { id },
      include: {
        contract: { select: { id: true, name: true, network: true } },
        alerts: {
          select: {
            id: true,
            title: true,
            severity: true,
            createdAt: true,
          },
        },
      },
    });

    if (!event) {
      return reply.status(404).send({
        type: 'https://soroban-watchdog.io/errors/resource-not-found',
        title: 'Not Found',
        status: 404,
        detail: `Event '${id}' not found.`,
        instance: request.url,
        timestamp: new Date().toISOString(),
      });
    }

    return {
      data: {
        ...event,
        ledger: event.ledger.toString(),
      },
    };
  });
};
