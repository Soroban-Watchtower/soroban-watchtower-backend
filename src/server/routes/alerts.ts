import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db/client.js';

export const alertRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // Query alerts with pagination and filters
  fastify.get('/api/v1/alerts', async (request) => {
    const query = z
      .object({
        contractId: z.string().optional(),
        severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
        ruleId: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(request.query);

    const where = {
      contractId: query.contractId,
      severity: query.severity,
      ruleId: query.ruleId,
    };

    const [total, alerts] = await Promise.all([
      prisma.alert.count({ where }),
      prisma.alert.findMany({
        where,
        include: {
          contract: { select: { id: true, name: true } },
          rule: { select: { id: true, name: true, detectorType: true } },
          deliveries: {
            select: {
              id: true,
              channelId: true,
              status: true,
              attempts: true,
              sentAt: true,
              lastError: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        skip: query.offset,
      }),
    ]);

    return {
      data: alerts,
      meta: {
        total,
        limit: query.limit,
        offset: query.offset,
        hasMore: query.offset + alerts.length < total,
      },
    };
  });

  // Get single alert by ID
  fastify.get('/api/v1/alerts/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const alert = await prisma.alert.findUnique({
      where: { id },
      include: {
        contract: true,
        rule: true,
        event: true,
        deliveries: {
          include: { channel: { select: { id: true, name: true, type: true } } },
        },
      },
    });

    if (!alert) {
      return reply.status(404).send({ error: `Alert '${id}' not found` });
    }

    return { data: alert };
  });
};
