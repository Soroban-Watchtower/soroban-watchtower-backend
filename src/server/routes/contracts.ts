import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db/client.js';
import { createCursorManager } from '../../ingest/cursorManager.js';

const registerContractSchema = z.object({
  id: z.string().min(56).max(56).regex(/^C[A-Z0-9]{55}$/, 'Must be a valid Soroban contract address starting with C'),
  name: z.string().min(1).max(100),
  network: z.enum(['TESTNET', 'MAINNET']).default('TESTNET'),
  active: z.boolean().default(true),
});

export const contractRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  const cursorManager = createCursorManager();

  // List all registered contracts
  fastify.get('/api/v1/contracts', async () => {
    const contracts = await prisma.contract.findMany({
      include: {
        ingestionStates: true,
        _count: { select: { events: true, rules: true, alerts: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const enriched = await Promise.all(
      contracts.map(async (c) => {
        const lagInfo = await cursorManager.getLag(c.id);
        return {
          id: c.id,
          name: c.name,
          network: c.network,
          active: c.active,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
          eventCount: c._count.events,
          ruleCount: c._count.rules,
          alertCount: c._count.alerts,
          cursor: c.ingestionStates[0]?.cursor || null,
          lastLedger: c.ingestionStates[0]?.lastLedgerSequence?.toString() || '0',
          chainLedger: lagInfo?.chainLedger?.toString() || '0',
          lagLedgers: Number(lagInfo?.lag || 0n),
          isSynced: lagInfo?.isSynced ?? false,
        };
      })
    );

    return { data: enriched };
  });

  // Register a new contract
  fastify.post('/api/v1/contracts', async (request, reply) => {
    const body = registerContractSchema.parse(request.body);

    const contract = await prisma.contract.create({
      data: {
        id: body.id,
        name: body.name,
        network: body.network,
        active: body.active,
      },
    });

    return reply.status(201).send({ data: contract });
  });

  // Get single contract details
  fastify.get('/api/v1/contracts/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const contract = await prisma.contract.findUnique({
      where: { id },
      include: {
        ingestionStates: true,
        rules: true,
        _count: { select: { events: true, alerts: true } },
      },
    });

    if (!contract) {
      return reply.status(404).send({ error: `Contract '${id}' not found` });
    }

    const lagInfo = await cursorManager.getLag(id);

    return {
      data: {
        ...contract,
        lag: lagInfo
          ? {
              lastLedger: lagInfo.lastLedger.toString(),
              chainLedger: lagInfo.chainLedger.toString(),
              lagLedgers: Number(lagInfo.lag),
              isSynced: lagInfo.isSynced,
            }
          : null,
      },
    };
  });

  // Update contract status or name
  fastify.patch('/api/v1/contracts/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = z
      .object({
        name: z.string().min(1).optional(),
        active: z.boolean().optional(),
      })
      .parse(request.body);

    const updated = await prisma.contract.update({
      where: { id },
      data: body,
    });

    return { data: updated };
  });

  // Delete contract
  fastify.delete('/api/v1/contracts/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await prisma.contract.delete({ where: { id } });
    return reply.status(204).send();
  });
};
