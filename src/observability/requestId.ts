import crypto from 'node:crypto';
import { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Generates an opaque, collision-resistant correlation request ID.
 */
export function generateRequestId(): string {
  return `req_${crypto.randomUUID().replace(/-/g, '')}`;
}

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
  }
}

const requestIdPluginAsync: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const existingHeader = request.headers[REQUEST_ID_HEADER];
    const requestId =
      typeof existingHeader === 'string' && existingHeader.trim().length > 0
        ? existingHeader.trim()
        : generateRequestId();

    request.requestId = requestId;
    reply.header(REQUEST_ID_HEADER, requestId);
  });
};

export const requestIdPlugin = fp(requestIdPluginAsync, {
  name: 'requestIdPlugin',
  fastify: '4.x',
});
