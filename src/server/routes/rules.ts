import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db/client.js';

const createRuleSchema = z.object({
  contractId: z.string().min(1),
  name: z.string().min(1).max(100),
  detectorType: z.enum([
    'LARGE_VALUE_TRANSFER',
    'RAPID_DRAIN',
    'EMERGENCY_PAUSE',
    'UNAUTHORIZED_CALLER',
    'FAILED_TX_BURST',
  ]),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
  parameters: z.record(z.any()).default({}),
  enabled: z.boolean().default(true),
  channelIds: z.array(z.string().uuid()).optional(),
});

export const ruleRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // List rules
  fastify.get('/api/v1/rules', async (request) => {
    const query = request.query as { contractId?: string };
    const rules = await prisma.rule.findMany({
      where: query.contractId ? { contractId: query.contractId } : undefined,
      include: {
        contract: { select: { id: true, name: true } },
        channels: { include: { channel: { select: { id: true, name: true, type: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return { data: rules };
  });

  // Create rule
  fastify.post('/api/v1/rules', async (request, reply) => {
    const body = createRuleSchema.parse(request.body);

    const rule = await prisma.rule.create({
      data: {
        contractId: body.contractId,
        name: body.name,
        detectorType: body.detectorType,
        severity: body.severity,
        parameters: body.parameters,
        enabled: body.enabled,
        channels: body.channelIds
          ? {
              create: body.channelIds.map((channelId) => ({
                channel: { connect: { id: channelId } },
              })),
            }
          : undefined,
      },
      include: {
        channels: { include: { channel: true } },
      },
    });

    return reply.status(201).send({ data: rule });
  });

  // Update rule
  fastify.patch('/api/v1/rules/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = z
      .object({
        name: z.string().optional(),
        severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
        parameters: z.record(z.any()).optional(),
        enabled: z.boolean().optional(),
      })
      .parse(request.body);

    const updated = await prisma.rule.update({
      where: { id },
      data: body,
    });

    return { data: updated };
  });

  // Delete rule
  fastify.delete('/api/v1/rules/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await prisma.rule.delete({ where: { id } });
    return reply.status(204).send();
  });
};
