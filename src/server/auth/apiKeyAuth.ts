import crypto from 'node:crypto';
import { FastifyReply, FastifyRequest } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { ApiKeyIdentity, ApiKeyScope } from '../../types/index.js';
import { prisma as defaultPrisma } from '../../db/client.js';
import { authFailuresTotal } from '../../observability/metrics.js';

declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: ApiKeyIdentity;
  }
}

export interface GeneratedApiKey {
  rawKey: string;
  keyHash: string;
  keyPrefix: string;
}

/**
 * Generates a cryptographically random, high-entropy API key.
 * Format: `sb_live_<48 hex chars>` or `sb_test_<48 hex chars>`
 */
export function generateApiKey(prefix: 'sb_live' | 'sb_test' = 'sb_live'): GeneratedApiKey {
  const randomPart = crypto.randomBytes(24).toString('hex');
  const rawKey = `${prefix}_${randomPart}`;
  const keyPrefix = `${rawKey.slice(0, 15)}...`;
  const keyHash = hashApiKey(rawKey);

  return { rawKey, keyHash, keyPrefix };
}

/**
 * Computes the SHA-256 hash of a raw API key.
 */
export function hashApiKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey.trim()).digest('hex');
}

/**
 * Extracts an API key token from HTTP request headers or query parameters.
 * Supports:
 * 1. 'x-api-key: sb_live_...'
 * 2. 'Authorization: Bearer sb_live_...'
 * 3. Query string '?api_key=sb_live_...' (essential for browser EventSource SSE streams)
 */
export function extractApiKey(request: FastifyRequest): string | null {
  const xApiKey = request.headers['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey.trim()) {
    return xApiKey.trim();
  }

  const authHeader = request.headers['authorization'];
  if (typeof authHeader === 'string') {
    const [scheme, token] = authHeader.trim().split(' ');
    if (scheme && scheme.toLowerCase() === 'bearer' && token) {
      return token.trim();
    }
  }

  const queryApiKey = (request.query as any)?.api_key;
  if (typeof queryApiKey === 'string' && queryApiKey.trim()) {
    return queryApiKey.trim();
  }

  return null;
}

export interface AuthenticateKeyOptions {
  prismaClient?: PrismaClient;
  masterApiKey?: string;
}

/**
 * Authenticates an API key string against master configuration and database records.
 */
export async function authenticateApiKey(
  rawKey: string,
  options: AuthenticateKeyOptions = {}
): Promise<ApiKeyIdentity | null> {
  const masterKey = options.masterApiKey || process.env.MASTER_API_KEY;

  // 1. Check Master Key (Bypasses DB, grants full wildcard scope)
  if (masterKey && rawKey.trim() === masterKey.trim()) {
    return {
      id: 'master',
      name: 'Master Gateway Administrator',
      keyPrefix: 'master_admin...',
      roles: ['*'],
      isMaster: true,
    };
  }

  // 2. Compute SHA-256 hash and query database
  const keyHash = hashApiKey(rawKey);
  const prisma = options.prismaClient || defaultPrisma;

  try {
    const apiKey = await prisma.apiKey.findUnique({
      where: { keyHash },
    });

    if (!apiKey || !apiKey.active) {
      authFailuresTotal.inc({ reason: 'invalid_key' });
      return null;
    }

    if (apiKey.expiresAt && apiKey.expiresAt.getTime() < Date.now()) {
      authFailuresTotal.inc({ reason: 'expired_key' });
      return null;
    }

    // Asynchronously record last usage timestamp
    try {
      const updatePromise = prisma.apiKey.update({
        where: { id: apiKey.id },
        data: { lastUsedAt: new Date() },
      });
      if (updatePromise && typeof (updatePromise as any).catch === 'function') {
        (updatePromise as any).catch(() => {
          // non-blocking
        });
      }
    } catch {
      // non-blocking
    }

    return {
      id: apiKey.id,
      name: apiKey.name,
      keyPrefix: apiKey.keyPrefix,
      roles: apiKey.roles,
      isMaster: false,
    };
  } catch {
    authFailuresTotal.inc({ reason: 'db_error' });
    return null;
  }
}

export interface RequireAuthOptions {
  scopes?: ApiKeyScope[];
  enabled?: boolean;
  prismaClient?: PrismaClient;
  masterApiKey?: string;
}

/**
 * PreHandler hook factory for Fastify routes to enforce API key authentication and role scopes.
 */
export function requireAuth(options: RequireAuthOptions = {}) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const serverAuthConfig = (request.server as any).authConfig;
    const isGloballyEnforced =
      options.enabled !== undefined
        ? options.enabled
        : serverAuthConfig?.enableAuth !== undefined
        ? serverAuthConfig.enableAuth
        : process.env.API_KEY_AUTH_ENABLED === 'true';

    const effectiveMasterKey =
      options.masterApiKey ||
      serverAuthConfig?.masterApiKey ||
      process.env.MASTER_API_KEY;

    const rawKey = extractApiKey(request);

    // If no key is provided:
    if (!rawKey) {
      if (!isGloballyEnforced) {
        // In local/dev testing mode without auth enforced, permit access with dev identity
        request.apiKey = {
          id: 'dev-anonymous',
          name: 'Developer Anonymous',
          keyPrefix: 'dev...',
          roles: ['*'],
          isMaster: false,
        };
        return;
      }

      authFailuresTotal.inc({ reason: 'missing_key' });
      return reply
        .status(401)
        .header('Content-Type', 'application/problem+json')
        .send({
          type: 'https://soroban-watchdog.io/errors/unauthorized',
          title: 'Unauthorized',
          status: 401,
          detail: "API key required. Provide via 'x-api-key' header, 'Authorization: Bearer <key>', or '?api_key=' parameter.",
          instance: request.url,
          timestamp: new Date().toISOString(),
        });
    }

    // Key was provided, authenticate it
    const identity = await authenticateApiKey(rawKey, {
      prismaClient: options.prismaClient,
      masterApiKey: effectiveMasterKey,
    });

    if (!identity) {
      return reply
        .status(401)
        .header('Content-Type', 'application/problem+json')
        .send({
          type: 'https://soroban-watchdog.io/errors/unauthorized',
          title: 'Unauthorized',
          status: 401,
          detail: 'Invalid or inactive API key provided.',
          instance: request.url,
          timestamp: new Date().toISOString(),
        });
    }

    // Check Role-Based Scopes
    if (options.scopes && options.scopes.length > 0) {
      const hasWildcard = identity.roles.includes('*');
      const hasAllRequiredScopes = options.scopes.every((requiredScope) =>
        identity.roles.includes(requiredScope)
      );

      if (!hasWildcard && !hasAllRequiredScopes) {
        authFailuresTotal.inc({ reason: 'insufficient_scope' });
        return reply
          .status(403)
          .header('Content-Type', 'application/problem+json')
          .send({
            type: 'https://soroban-watchdog.io/errors/forbidden',
            title: 'Forbidden',
            status: 403,
            detail: `Insufficient permissions. Required scope(s): ${options.scopes.join(', ')}`,
            instance: request.url,
            timestamp: new Date().toISOString(),
          });
      }
    }

    request.apiKey = identity;
  };
}
