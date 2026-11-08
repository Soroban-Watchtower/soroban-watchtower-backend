import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db/client.js';
import { generateApiKey, requireAuth } from '../auth/apiKeyAuth.js';
import { ApiKeyScope } from '../../types/index.js';

const validScopes: ApiKeyScope[] = [
  'read:telemetry',
  'read:alerts',
  'read:events',
  'write:contracts',
  'write:rules',
  'admin:channels',
  'admin:keys',
  '*',
];

const createApiKeySchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  roles: z.array(z.enum(validScopes as [ApiKeyScope, ...ApiKeyScope[]])).min(1, 'At least one role scope is required'),
  rateLimit: z.number().int().positive().optional().default(1000),
  expiresInDays: z.number().int().positive().optional(),
  prefix: z.enum(['sb_live', 'sb_test']).optional().default('sb_live'),
});

export async function apiKeyRoutes(fastify: FastifyInstance): Promise<void> {
  // Create a new API key (Requires admin:keys scope)
  fastify.post(
    '/api/v1/api-keys',
    {
      preHandler: [requireAuth({ scopes: ['admin:keys'] })],
    },
    async (request, reply) => {
      const body = createApiKeySchema.parse(request.body);
      const { rawKey, keyHash, keyPrefix } = generateApiKey(body.prefix);

      const expiresAt = body.expiresInDays
        ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000)
        : null;

      const apiKey = await prisma.apiKey.create({
        data: {
          name: body.name,
          keyHash,
          keyPrefix,
          roles: body.roles,
          rateLimit: body.rateLimit,
          expiresAt,
        },
      });

      return reply.status(201).send({
        data: {
          id: apiKey.id,
          name: apiKey.name,
          apiKey: rawKey, // Plaintext key returned ONCE at generation time
          keyPrefix: apiKey.keyPrefix,
          roles: apiKey.roles,
          rateLimit: apiKey.rateLimit,
          expiresAt: apiKey.expiresAt,
          createdAt: apiKey.createdAt,
        },
      });
    }
  );

  // List all API keys (Sanitized, never exposes raw keys or hashes)
  fastify.get(
    '/api/v1/api-keys',
    {
      preHandler: [requireAuth({ scopes: ['admin:keys'] })],
    },
    async (_request, reply) => {
      const keys = await prisma.apiKey.findMany({
        orderBy: { createdAt: 'desc' },
      });

      const sanitized = keys.map((k) => ({
        id: k.id,
        name: k.name,
        keyPrefix: k.keyPrefix,
        roles: k.roles,
        rateLimit: k.rateLimit,
        active: k.active,
        expiresAt: k.expiresAt,
        lastUsedAt: k.lastUsedAt,
        createdAt: k.createdAt,
      }));

      return reply.send({ data: sanitized });
    }
  );

  // Revoke / delete API key
  fastify.delete(
    '/api/v1/api-keys/:id',
    {
      preHandler: [requireAuth({ scopes: ['admin:keys'] })],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await prisma.apiKey.delete({ where: { id } });
      return reply.status(204).send();
    }
  );
}
