import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db/client.js';
import { encrypt, decrypt } from '../../db/encryption.js';

const createChannelSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['DISCORD', 'TELEGRAM', 'WEBHOOK']),
  destination: z.string().min(1),
  secret: z.string().optional(),
});

function maskDestination(dest: string): string {
  try {
    const url = new URL(dest);
    return `${url.protocol}//${url.hostname}/...${url.pathname.slice(-6)}`;
  } catch {
    return '***masked***';
  }
}

export const channelRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // List notification channels (secrets omitted, destinations masked)
  fastify.get('/api/v1/channels', async () => {
    const channels = await prisma.channel.findMany({
      include: {
        _count: { select: { rules: true, deliveries: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const sanitized = channels.map((c) => {
      let plaintextDest = c.destination;
      try {
        plaintextDest = decrypt(c.destination);
      } catch {
        // if not encrypted or error, treat as raw
      }

      return {
        id: c.id,
        name: c.name,
        type: c.type,
        destinationMasked: maskDestination(plaintextDest),
        hasSecret: Boolean(c.secret),
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        ruleCount: c._count.rules,
        deliveryCount: c._count.deliveries,
      };
    });

    return { data: sanitized };
  });

  // Create new channel (destination and secret encrypted using AES-256-GCM)
  fastify.post('/api/v1/channels', async (request, reply) => {
    const body = createChannelSchema.parse(request.body);

    const encryptedDestination = encrypt(body.destination);
    const encryptedSecret = body.secret ? encrypt(body.secret) : null;

    const channel = await prisma.channel.create({
      data: {
        name: body.name,
        type: body.type,
        destination: encryptedDestination,
        secret: encryptedSecret,
      },
    });

    return reply.status(201).send({
      data: {
        id: channel.id,
        name: channel.name,
        type: channel.type,
        destinationMasked: maskDestination(body.destination),
        hasSecret: Boolean(body.secret),
        createdAt: channel.createdAt,
      },
    });
  });

  // Delete channel
  fastify.delete('/api/v1/channels/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await prisma.channel.delete({ where: { id } });
    return reply.status(204).send();
  });
};
