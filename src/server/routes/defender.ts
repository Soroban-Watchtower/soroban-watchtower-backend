import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db/client.js';
import { getIncidentResponder } from '../../defender/incidentResponder.js';
import { requireAuth } from '../auth/apiKeyAuth.js';

const simulateSchema = z.object({
  contractId: z.string().min(56).max(56).regex(/^C[A-Z0-9]{55}$/, 'Must be a valid Soroban contract address'),
  functionName: z.string().min(1).default('pause'),
  args: z.array(z.any()).optional().default([]),
});

export const defenderRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  const responder = getIncidentResponder();

  // GET /api/v1/defender/status: Guardian defender status
  fastify.get(
    '/api/v1/defender/status',
    {
      preHandler: [requireAuth({ scopes: ['read:telemetry'] })],
    },
    async (_request, reply) => {
      const status = responder.getStatus();
      return reply.send({ data: status });
    }
  );

  // GET /api/v1/defender/executions: List on-chain defensive intervention records
  fastify.get(
    '/api/v1/defender/executions',
    {
      preHandler: [requireAuth({ scopes: ['read:alerts'] })],
    },
    async (request) => {
      const query = z
        .object({
          contractId: z.string().optional(),
          status: z.enum(['PENDING', 'SIMULATED', 'SUBMITTED', 'CONFIRMED', 'FAILED']).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(20),
          offset: z.coerce.number().int().min(0).default(0),
        })
        .parse(request.query);

      const where = {
        contractId: query.contractId,
        status: query.status,
      };

      const [total, executions] = await Promise.all([
        prisma.actionExecution.count({ where }),
        prisma.actionExecution.findMany({
          where,
          include: {
            rule: { select: { id: true, name: true, detectorType: true } },
            alert: { select: { id: true, title: true, severity: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: query.limit,
          skip: query.offset,
        }),
      ]);

      const serialized = executions.map((e) => ({
        ...e,
        ledgerSequence: e.ledgerSequence ? e.ledgerSequence.toString() : null,
      }));

      return {
        data: serialized,
        meta: {
          total,
          limit: query.limit,
          offset: query.offset,
          hasMore: query.offset + executions.length < total,
        },
      };
    }
  );

  // POST /api/v1/defender/simulate: Dry-run circuit breaker simulation
  fastify.post(
    '/api/v1/defender/simulate',
    {
      preHandler: [requireAuth({ scopes: ['write:rules'] })],
    },
    async (request, reply) => {
      const body = simulateSchema.parse(request.body);
      const simResult = await responder.simulateDryRun(
        body.contractId,
        body.functionName,
        body.args
      );

      return reply.send({ data: simResult });
    }
  );
};

