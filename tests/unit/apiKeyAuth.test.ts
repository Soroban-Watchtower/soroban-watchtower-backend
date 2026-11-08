import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { FastifyInstance } from 'fastify';

const mockPrisma = vi.hoisted(() => ({
  channel: {
    findMany: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    delete: vi.fn(),
  },
  apiKey: {
    findMany: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn(),
  },
  contract: {
    findMany: vi.fn().mockResolvedValue([]),
  },
  rule: {
    findMany: vi.fn().mockResolvedValue([]),
  },
  alert: {
    count: vi.fn().mockResolvedValue(0),
    findMany: vi.fn().mockResolvedValue([]),
  },
  event: {
    count: vi.fn().mockResolvedValue(0),
    findMany: vi.fn().mockResolvedValue([]),
  },
  ingestionState: {
    findUnique: vi.fn().mockResolvedValue(null),
  },
  $queryRaw: vi.fn().mockResolvedValue([{ 1: 1 }]),
}));

vi.mock('../../src/db/client.js', () => ({
  prisma: mockPrisma,
  createPrismaClient: () => mockPrisma,
  disconnectPrisma: vi.fn(),
  default: mockPrisma,
}));

import {
  generateApiKey,
  hashApiKey,
  extractApiKey,
  authenticateApiKey,
} from '../../src/server/auth/apiKeyAuth.js';
import { buildServer } from '../../src/server/server.js';

describe('Secured API Key Gateway & Role-Based Authorization (src/server/auth)', () => {
  describe('Key Generation & Hashing Utilities', () => {
    it('should generate cryptographically secure keys with prefix and SHA-256 hash', () => {
      const generated = generateApiKey('sb_live');
      expect(generated.rawKey).toMatch(/^sb_live_[0-9a-f]{48}$/);
      expect(generated.keyPrefix).toMatch(/^sb_live_[0-9a-f]{7}\.\.\.$/);
      expect(generated.keyHash).toHaveLength(64);

      // Hash must match SHA-256 calculation
      const computedHash = hashApiKey(generated.rawKey);
      expect(generated.keyHash).toBe(computedHash);
    });

    it('should support test prefix (sb_test)', () => {
      const generated = generateApiKey('sb_test');
      expect(generated.rawKey).toMatch(/^sb_test_[0-9a-f]{48}$/);
      expect(generated.keyPrefix).toMatch(/^sb_test_/);
    });

    it('should extract API keys from various HTTP delivery mechanisms', () => {
      // 1. x-api-key header
      const reqWithHeader = {
        headers: { 'x-api-key': 'sb_live_header_token' },
        query: {},
      } as any;
      expect(extractApiKey(reqWithHeader)).toBe('sb_live_header_token');

      // 2. Authorization: Bearer token
      const reqWithBearer = {
        headers: { authorization: 'Bearer sb_live_bearer_token' },
        query: {},
      } as any;
      expect(extractApiKey(reqWithBearer)).toBe('sb_live_bearer_token');

      // 3. Query string (?api_key=...)
      const reqWithQuery = {
        headers: {},
        query: { api_key: 'sb_live_query_token' },
      } as any;
      expect(extractApiKey(reqWithQuery)).toBe('sb_live_query_token');

      // 4. No key provided
      const reqEmpty = { headers: {}, query: {} } as any;
      expect(extractApiKey(reqEmpty)).toBeNull();
    });
  });

  describe('Master Key & Database Authentication', () => {
    it('should authenticate master admin key with wildcard permissions', async () => {
      const identity = await authenticateApiKey('super-master-key-xyz', {
        masterApiKey: 'super-master-key-xyz',
      });

      expect(identity).not.toBeNull();
      expect(identity?.id).toBe('master');
      expect(identity?.roles).toContain('*');
      expect(identity?.isMaster).toBe(true);
    });

    it('should authenticate active database keys and verify expiration', async () => {
      const rawKey = 'sb_live_test_valid_key_123';
      const keyHash = hashApiKey(rawKey);

      const mockPrismaClient = {
        apiKey: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'key-uuid-1',
            name: 'Production Ingestion Service',
            keyHash,
            keyPrefix: 'sb_live_test_val...',
            roles: ['write:contracts', 'read:telemetry'],
            active: true,
            expiresAt: null,
          }),
          update: vi.fn().mockResolvedValue({}),
        },
      } as any;

      const identity = await authenticateApiKey(rawKey, {
        prismaClient: mockPrismaClient,
      });

      expect(identity).not.toBeNull();
      expect(identity?.id).toBe('key-uuid-1');
      expect(identity?.roles).toEqual(['write:contracts', 'read:telemetry']);
      expect(mockPrismaClient.apiKey.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'key-uuid-1' } })
      );
    });

    it('should reject expired database keys', async () => {
      const rawKey = 'sb_live_expired_key';
      const keyHash = hashApiKey(rawKey);

      const mockPrismaClient = {
        apiKey: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'key-uuid-expired',
            name: 'Expired Key',
            keyHash,
            keyPrefix: 'sb_live_expired...',
            roles: ['read:telemetry'],
            active: true,
            expiresAt: new Date(Date.now() - 3600000), // expired 1 hour ago
          }),
        },
      } as any;

      const identity = await authenticateApiKey(rawKey, {
        prismaClient: mockPrismaClient,
      });

      expect(identity).toBeNull();
    });

    it('should reject deactivated / inactive database keys', async () => {
      const rawKey = 'sb_live_revoked_key';
      const keyHash = hashApiKey(rawKey);

      const mockPrismaClient = {
        apiKey: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'key-uuid-revoked',
            name: 'Revoked Key',
            keyHash,
            keyPrefix: 'sb_live_revoked...',
            roles: ['read:telemetry'],
            active: false,
          }),
        },
      } as any;

      const identity = await authenticateApiKey(rawKey, {
        prismaClient: mockPrismaClient,
      });

      expect(identity).toBeNull();
    });
  });

  describe('Gateway Enforcement & Scope-Based Authorization HTTP Pipeline', () => {
    let serverWithAuth: FastifyInstance;
    const testMasterKey = 'master-secret-watchdog-key';

    beforeAll(async () => {
      serverWithAuth = await buildServer({
        enableLogging: false,
        enableAuth: true,
        masterApiKey: testMasterKey,
      });
      await serverWithAuth.ready();
    });

    afterAll(async () => {
      await serverWithAuth.close();
    });

    it('should allow public health checks without authentication', async () => {
      const res = await serverWithAuth.inject({
        method: 'GET',
        url: '/healthz',
      });
      expect(res.statusCode).toBe(200);
    });

    it('should reject unauthenticated requests to protected endpoints with 401 Problem Details', async () => {
      const res = await serverWithAuth.inject({
        method: 'GET',
        url: '/api/v1/channels',
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.type).toBe('https://soroban-watchdog.io/errors/unauthorized');
      expect(body.title).toBe('Unauthorized');
      expect(body.status).toBe(401);
    });

    it('should reject requests with invalid API keys with 401 Problem Details', async () => {
      const res = await serverWithAuth.inject({
        method: 'GET',
        url: '/api/v1/channels',
        headers: {
          'x-api-key': 'sb_live_completely_bogus_key',
        },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.type).toBe('https://soroban-watchdog.io/errors/unauthorized');
    });

    it('should allow master API key to access protected routes with wildcard scope', async () => {
      const res = await serverWithAuth.inject({
        method: 'GET',
        url: '/api/v1/channels',
        headers: {
          'x-api-key': testMasterKey,
        },
      });

      // 200 OK because master key has wildcard '*' scope
      expect(res.statusCode).toBe(200);
    });

    it('should allow master API key via Authorization: Bearer header', async () => {
      const res = await serverWithAuth.inject({
        method: 'GET',
        url: '/api/v1/channels',
        headers: {
          authorization: `Bearer ${testMasterKey}`,
        },
      });

      expect(res.statusCode).toBe(200);
    });

    it('should allow master API key via query parameter (?api_key=...) for SSE support', async () => {
      const res = await serverWithAuth.inject({
        method: 'GET',
        url: `/api/v1/stream/stats?api_key=${testMasterKey}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toBeDefined();
    });

    it('should reject requests with 403 Forbidden when key lacks required scopes', async () => {
      const scopedKey = 'sb_live_telemetry_only_key_123';
      const scopedHash = hashApiKey(scopedKey);

      mockPrisma.apiKey.findUnique.mockResolvedValueOnce({
        id: 'key-scoped-1',
        name: 'Telemetry Reader Bot',
        keyHash: scopedHash,
        keyPrefix: 'sb_live_telemet...',
        roles: ['read:telemetry'],
        active: true,
      });

      // Calling /api/v1/channels requires 'admin:channels' scope
      const res = await serverWithAuth.inject({
        method: 'GET',
        url: '/api/v1/channels',
        headers: {
          'x-api-key': scopedKey,
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.type).toBe('https://soroban-watchdog.io/errors/forbidden');
      expect(body.title).toBe('Forbidden');
      expect(body.detail).toContain('admin:channels');
    });

    it('should create new API key via POST /api/v1/api-keys', async () => {
      mockPrisma.apiKey.create.mockImplementationOnce(({ data }) =>
        Promise.resolve({
          id: 'new-key-uuid',
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
      );

      const res = await serverWithAuth.inject({
        method: 'POST',
        url: '/api/v1/api-keys',
        headers: {
          'x-api-key': testMasterKey,
        },
        payload: {
          name: 'Dashboard UI Key',
          roles: ['read:telemetry', 'read:alerts'],
          prefix: 'sb_live',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.data.name).toBe('Dashboard UI Key');
      expect(body.data.apiKey).toMatch(/^sb_live_[0-9a-f]{48}$/);
      expect(body.data.roles).toEqual(['read:telemetry', 'read:alerts']);
    });

    it('should list sanitized API keys via GET /api/v1/api-keys', async () => {
      mockPrisma.apiKey.findMany.mockResolvedValueOnce([
        {
          id: 'key-1',
          name: 'Dashboard UI Key',
          keyHash: 'hash-secret',
          keyPrefix: 'sb_live_abcd123...',
          roles: ['read:telemetry'],
          rateLimit: 1000,
          active: true,
          expiresAt: null,
          lastUsedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const res = await serverWithAuth.inject({
        method: 'GET',
        url: '/api/v1/api-keys',
        headers: {
          'x-api-key': testMasterKey,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].name).toBe('Dashboard UI Key');
      expect(body.data[0].keyPrefix).toBe('sb_live_abcd123...');
      // Must NEVER expose the raw secret or full hash
      expect(body.data[0].keyHash).toBeUndefined();
      expect(body.data[0].apiKey).toBeUndefined();
    });

    it('should delete / revoke an API key via DELETE /api/v1/api-keys/:id', async () => {
      mockPrisma.apiKey.delete.mockResolvedValueOnce({ id: 'key-1' });

      const res = await serverWithAuth.inject({
        method: 'DELETE',
        url: '/api/v1/api-keys/key-1',
        headers: {
          'x-api-key': testMasterKey,
        },
      });

      expect(res.statusCode).toBe(204);
      expect(mockPrisma.apiKey.delete).toHaveBeenCalledWith({ where: { id: 'key-1' } });
    });
  });
});
