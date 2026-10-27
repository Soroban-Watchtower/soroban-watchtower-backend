import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { FastifyInstance } from 'fastify';

const mockPrisma = vi.hoisted(() => ({
  contract: {
    findMany: vi.fn(),
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  rule: {
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  channel: {
    findMany: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
  event: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    count: vi.fn(),
  },
  alert: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    count: vi.fn(),
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

import { buildServer } from '../../src/server/server.js';
import { encrypt } from '../../src/db/encryption.js';

describe('Fastify REST API Subsystem (src/server/routes)', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await buildServer({ enableLogging: false });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  // -------------------------------------------------------------
  // 1. POST /api/v1/contracts
  // -------------------------------------------------------------
  describe('POST /api/v1/contracts', () => {
    const validContractAddress = 'CA3D5KRYMCMUZGTAQAWXXAZ264BVVCXCHHQETBRVFRKZXXOIS4K5P35B';

    it('should register a valid Soroban contract address', async () => {
      mockPrisma.contract.create.mockResolvedValueOnce({
        id: validContractAddress,
        name: 'Liquidity Pool Contract',
        network: 'TESTNET',
        active: true,
        createdAt: new Date('2026-10-25T10:00:00Z'),
        updatedAt: new Date('2026-10-25T10:00:00Z'),
      });

      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/contracts',
        payload: {
          id: validContractAddress,
          name: 'Liquidity Pool Contract',
          network: 'TESTNET',
          active: true,
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data).toBeDefined();
      expect(body.data.id).toBe(validContractAddress);
      expect(body.data.name).toBe('Liquidity Pool Contract');
      expect(mockPrisma.contract.create).toHaveBeenCalledWith({
        data: {
          id: validContractAddress,
          name: 'Liquidity Pool Contract',
          network: 'TESTNET',
          active: true,
        },
      });
    });

    it('should reject invalid contract address format (not starting with C or invalid length)', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/contracts',
        payload: {
          id: 'INVALID_CONTRACT_ADDRESS_123',
          name: 'Invalid Contract',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.type).toBe('https://soroban-watchdog.io/errors/validation-error');
      expect(body.invalidParams).toBeDefined();
      expect(body.invalidParams.some((p: any) => p.field === 'id')).toBe(true);
    });

    it('should reject missing contract name with 400 Problem Details', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/contracts',
        payload: {
          id: validContractAddress,
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.type).toBe('https://soroban-watchdog.io/errors/validation-error');
      expect(body.invalidParams.some((p: any) => p.field === 'name')).toBe(true);
    });
  });

  // -------------------------------------------------------------
  // 2. POST /api/v1/rules
  // -------------------------------------------------------------
  describe('POST /api/v1/rules', () => {
    const validContractAddress = 'CA3D5KRYMCMUZGTAQAWXXAZ264BVVCXCHHQETBRVFRKZXXOIS4K5P35B';

    it('should create an alert rule for a contract with valid detectors and parameters', async () => {
      const createdRule = {
        id: 'rule-uuid-101',
        contractId: validContractAddress,
        name: 'Detect Large Flash Drain',
        detectorType: 'LARGE_VALUE_TRANSFER',
        severity: 'CRITICAL',
        parameters: { threshold: '10000000000', token: 'USDC' },
        enabled: true,
        channels: [],
        createdAt: new Date('2026-10-25T10:00:00Z'),
        updatedAt: new Date('2026-10-25T10:00:00Z'),
      };
      mockPrisma.rule.create.mockResolvedValueOnce(createdRule);

      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/rules',
        payload: {
          contractId: validContractAddress,
          name: 'Detect Large Flash Drain',
          detectorType: 'LARGE_VALUE_TRANSFER',
          severity: 'CRITICAL',
          parameters: { threshold: '10000000000', token: 'USDC' },
          enabled: true,
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data.id).toBe('rule-uuid-101');
      expect(body.data.detectorType).toBe('LARGE_VALUE_TRANSFER');
      expect(body.data.severity).toBe('CRITICAL');
      expect(mockPrisma.rule.create).toHaveBeenCalled();
    });

    it('should reject invalid detector types with 400 validation error', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/rules',
        payload: {
          contractId: validContractAddress,
          name: 'Bogus Detector Rule',
          detectorType: 'UNKNOWN_NONEXISTENT_DETECTOR',
          severity: 'HIGH',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.type).toBe('https://soroban-watchdog.io/errors/validation-error');
      expect(body.invalidParams.some((p: any) => p.field === 'detectorType')).toBe(true);
    });

    it('should connect channels when channelIds array is provided', async () => {
      const channelId = '11111111-2222-3333-4444-555555555555';
      mockPrisma.rule.create.mockResolvedValueOnce({
        id: 'rule-uuid-102',
        contractId: validContractAddress,
        name: 'Emergency Pause Detector',
        detectorType: 'EMERGENCY_PAUSE',
        severity: 'HIGH',
        parameters: {},
        enabled: true,
        channels: [{ channel: { id: channelId, name: 'Ops Discord' } }],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/rules',
        payload: {
          contractId: validContractAddress,
          name: 'Emergency Pause Detector',
          detectorType: 'EMERGENCY_PAUSE',
          severity: 'HIGH',
          channelIds: [channelId],
        },
      });

      expect(response.statusCode).toBe(201);
      expect(mockPrisma.rule.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            channels: {
              create: [{ channel: { connect: { id: channelId } } }],
            },
          }),
        })
      );
    });
  });

  // -------------------------------------------------------------
  // 3. POST /api/v1/channels
  // -------------------------------------------------------------
  describe('POST /api/v1/channels', () => {
    it('should add a Discord notification channel and encrypt destination at rest', async () => {
      const rawWebhook = 'https://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz';

      mockPrisma.channel.create.mockImplementationOnce(async ({ data }: any) => ({
        id: 'chan-uuid-discord',
        name: data.name,
        type: data.type,
        destination: data.destination,
        secret: data.secret,
        createdAt: new Date('2026-10-25T11:00:00Z'),
        updatedAt: new Date('2026-10-25T11:00:00Z'),
      }));

      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/channels',
        payload: {
          name: 'Security Ops Discord',
          type: 'DISCORD',
          destination: rawWebhook,
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data).toBeDefined();
      expect(body.data.name).toBe('Security Ops Discord');
      expect(body.data.type).toBe('DISCORD');
      // Plaintext webhook destination must be masked in response to protect webhook token
      expect(body.data.destinationMasked).not.toBe(rawWebhook);
      expect(body.data.destinationMasked).toContain('discord.com');

      // Verify Prisma received an encrypted ciphertext destination, NOT plaintext
      const callArgs = mockPrisma.channel.create.mock.calls[0][0];
      expect(callArgs.data.destination).not.toBe(rawWebhook);
      expect(callArgs.data.destination).toContain(':'); // IV:AuthTag:Ciphertext format
    });

    it('should add a Webhook destination with HMAC signing secret', async () => {
      mockPrisma.channel.create.mockClear();
      mockPrisma.channel.create.mockImplementationOnce(async ({ data }: any) => ({
        id: 'chan-uuid-webhook',
        name: data.name,
        type: data.type,
        destination: data.destination,
        secret: data.secret,
        createdAt: new Date('2026-10-25T11:00:00Z'),
        updatedAt: new Date('2026-10-25T11:00:00Z'),
      }));

      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/channels',
        payload: {
          name: 'Partner Webhook',
          type: 'WEBHOOK',
          destination: 'https://partner.xyz/watchdog/webhook',
          secret: 'super-secret-hmac-key',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data.hasSecret).toBe(true);

      const callArgs = mockPrisma.channel.create.mock.calls[0][0];
      expect(callArgs.data.secret).not.toBe('super-secret-hmac-key');
    });

    it('should reject invalid channel types with 400 validation error', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/channels',
        payload: {
          name: 'Invalid Channel',
          type: 'SLACK', // Not in ['DISCORD', 'TELEGRAM', 'WEBHOOK']
          destination: 'https://slack.com/hook',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.type).toBe('https://soroban-watchdog.io/errors/validation-error');
    });
  });

  // -------------------------------------------------------------
  // 4. GET /api/v1/events
  // -------------------------------------------------------------
  describe('GET /api/v1/events & GET /api/v1/events/:id', () => {
    const mockEvents = [
      {
        id: '005000-0001-0000',
        contractId: 'CA3D5KRYMCMUZGTAQAWXXAZ264BVVCXCHHQETBRVFRKZXXOIS4K5P35B',
        type: 'contract',
        ledger: 5000n, // BigInt from Prisma
        ledgerClosedAt: new Date('2026-10-25T12:00:00Z'),
        txHash: 'txhash_abc_123',
        topics: ['transfer', 'source_addr', 'dest_addr'],
        data: { amount: '1000000000' },
        rawXdr: 'AAAA...',
        createdAt: new Date('2026-10-25T12:00:01Z'),
        contract: {
          id: 'CA3D5KRYMCMUZGTAQAWXXAZ264BVVCXCHHQETBRVFRKZXXOIS4K5P35B',
          name: 'Vault Contract',
          network: 'TESTNET',
        },
      },
    ];

    it('should return historical events with pagination metadata and serialize BigInt ledger', async () => {
      mockPrisma.event.count.mockResolvedValueOnce(1);
      mockPrisma.event.findMany.mockResolvedValueOnce(mockEvents);

      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/events?limit=10&offset=0',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe('005000-0001-0000');
      // Must be serialized to string, not thrown by JSON serializer
      expect(body.data[0].ledger).toBe('5000');
      expect(body.meta).toEqual({
        total: 1,
        limit: 10,
        offset: 0,
        hasMore: false,
      });
    });

    it('should filter events by contractId and ledger sequence', async () => {
      mockPrisma.event.count.mockResolvedValueOnce(0);
      mockPrisma.event.findMany.mockResolvedValueOnce([]);

      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/events?contractId=CA3D5KRYMCMUZGTAQAWXXAZ264BVVCXCHHQETBRVFRKZXXOIS4K5P35B&ledger=5000',
      });

      expect(response.statusCode).toBe(200);
      expect(mockPrisma.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            contractId: 'CA3D5KRYMCMUZGTAQAWXXAZ264BVVCXCHHQETBRVFRKZXXOIS4K5P35B',
            ledger: 5000n,
          }),
        })
      );
    });

    it('should retrieve a single event by ID with stringified ledger', async () => {
      mockPrisma.event.findUnique.mockResolvedValueOnce({
        ...mockEvents[0],
        alerts: [{ id: 'alert-1', title: 'Suspicious Drain', severity: 'HIGH', createdAt: new Date() }],
      });

      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/events/005000-0001-0000',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.id).toBe('005000-0001-0000');
      expect(body.data.ledger).toBe('5000');
      expect(body.data.alerts).toHaveLength(1);
    });

    it('should return 404 when querying a non-existent event ID', async () => {
      mockPrisma.event.findUnique.mockResolvedValueOnce(null);

      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/events/non-existent-event-id',
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.type).toBe('https://soroban-watchdog.io/errors/resource-not-found');
    });
  });

  // -------------------------------------------------------------
  // 5. GET /api/v1/alerts
  // -------------------------------------------------------------
  describe('GET /api/v1/alerts & GET /api/v1/alerts/:id', () => {
    const mockAlerts = [
      {
        id: 'alert-uuid-1',
        ruleId: 'rule-1',
        contractId: 'CA3D5KRYMCMUZGTAQAWXXAZ264BVVCXCHHQETBRVFRKZXXOIS4K5P35B',
        eventId: '005000-0001-0000',
        severity: 'CRITICAL',
        title: 'Rapid Drain Anomaly Detected',
        message: 'Contract balance drained 95% within 1 ledger',
        metadata: { dropPercentage: 0.95 },
        createdAt: new Date('2026-10-25T12:05:00Z'),
        contract: { id: 'CA3D5KRYMCMUZGTAQAWXXAZ264BVVCXCHHQETBRVFRKZXXOIS4K5P35B', name: 'Vault Contract' },
        rule: { id: 'rule-1', name: 'Rapid Drain Rule', detectorType: 'RAPID_DRAIN' },
        deliveries: [
          {
            id: 'delivery-1',
            channelId: 'chan-1',
            status: 'DELIVERED',
            attempts: 1,
            sentAt: new Date('2026-10-25T12:05:02Z'),
            lastError: null,
          },
        ],
      },
    ];

    it('should query alerts with pagination and severity filter', async () => {
      mockPrisma.alert.count.mockResolvedValueOnce(1);
      mockPrisma.alert.findMany.mockResolvedValueOnce(mockAlerts);

      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/alerts?severity=CRITICAL&limit=20',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe('alert-uuid-1');
      expect(body.data[0].severity).toBe('CRITICAL');
      expect(body.meta.total).toBe(1);
      expect(mockPrisma.alert.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ severity: 'CRITICAL' }),
        })
      );
    });

    it('should retrieve a single alert by ID', async () => {
      mockPrisma.alert.findUnique.mockResolvedValueOnce(mockAlerts[0]);

      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/alerts/alert-uuid-1',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.id).toBe('alert-uuid-1');
      expect(body.data.title).toBe('Rapid Drain Anomaly Detected');
    });

    it('should return 404 when alert does not exist', async () => {
      mockPrisma.alert.findUnique.mockResolvedValueOnce(null);

      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/alerts/missing-alert-uuid',
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('missing-alert-uuid');
    });
  });
});
