import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { Keypair, SorobanRpc, StrKey, SorobanDataBuilder } from '@stellar/stellar-sdk';
import { DefenderKeyVault } from '../../src/defender/keyVault.js';
import { IncidentResponder } from '../../src/defender/incidentResponder.js';
import { StreamBus } from '../../src/server/streaming/streamBus.js';
import { encrypt } from '../../src/db/encryption.js';
import { AlertPayload, ResponseActionPolicy } from '../../src/types/index.js';
import { buildServer } from '../../src/server/server.js';

// Deterministic valid test contract address (starts with C, 56 chars)
const TEST_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 7));

describe('Automated On-Chain Incident Response & Defense Subsystem (src/defender)', () => {
  describe('DefenderKeyVault', () => {
    it('should initialize with valid plaintext Stellar secret key', () => {
      const generated = Keypair.random();
      const vault = new DefenderKeyVault({ secretKey: generated.secret() });

      expect(vault.isConfigured()).toBe(true);
      expect(vault.getPublicKey()).toBe(generated.publicKey());
      expect(vault.getKeypair().secret()).toBe(generated.secret());
    });

    it('should decrypt AES-256 encrypted secret key', () => {
      const generated = Keypair.random();
      const encryptedSecret = encrypt(generated.secret());
      const vault = new DefenderKeyVault({ encryptedSecretKey: encryptedSecret });

      expect(vault.isConfigured()).toBe(true);
      expect(vault.getPublicKey()).toBe(generated.publicKey());
    });

    it('should fallback to ephemeral mock keypair if no secret is configured', () => {
      const vault = new DefenderKeyVault({ secretKey: '' });

      expect(vault.isConfigured()).toBe(false);
      expect(vault.getPublicKey()).toMatch(/^G[A-Z0-9]{55}$/);
    });

    it('should handle malformed secret keys gracefully without crashing', () => {
      const vault = new DefenderKeyVault({ secretKey: 'not-a-stellar-key' });

      expect(vault.isConfigured()).toBe(false);
      expect(vault.getPublicKey()).toMatch(/^G[A-Z0-9]{55}$/);
    });
  });

  describe('IncidentResponder Execution Pipeline', () => {
    let mockPrisma: any;
    let mockRpc: any;
    let streamBus: StreamBus;
    let keyVault: DefenderKeyVault;
    let responder: IncidentResponder;

    const sampleAlert: AlertPayload = {
      alertId: 'alert_exploit_999',
      contractId: TEST_CONTRACT_ID,
      ruleId: 'rule_drain_1',
      severity: 'CRITICAL',
      title: 'Rapid Outflow Exploit Detected',
      message: 'Pool balance drained by 40% in 2 ledgers',
      timestamp: new Date(),
      metadata: { outflow: '50000000' },
      explorerUrl: 'https://stellar.expert/explorer/testnet/tx/1',
    };

    beforeAll(() => {
      keyVault = new DefenderKeyVault({ secretKey: Keypair.random().secret() });
      streamBus = new StreamBus();

      mockPrisma = {
        actionExecution: {
          create: vi.fn().mockImplementation(({ data }) =>
            Promise.resolve({
              id: 'exec_abc_123',
              ...data,
              createdAt: new Date(),
            })
          ),
          update: vi.fn().mockResolvedValue({}),
        },
      };

      mockRpc = {
        getAccount: vi.fn().mockResolvedValue({ sequence: '500' }),
        simulateTransaction: vi.fn(),
        sendTransaction: vi.fn(),
        getTransaction: vi.fn(),
      };

      responder = new IncidentResponder({
        keyVault,
        prismaClient: mockPrisma,
        streamBus,
      });

      // Inject mock RPC server directly
      (responder as any).rpcServer = mockRpc;
    });

    beforeEach(() => {
      vi.clearAllMocks();
      mockRpc.getAccount.mockResolvedValue({ sequence: '500' });
      mockPrisma.actionExecution.create.mockImplementation(({ data }: any) =>
        Promise.resolve({
          id: 'exec_abc_123',
          ...data,
          createdAt: new Date(),
        })
      );
      mockPrisma.actionExecution.update.mockResolvedValue({});
    });

    it('should simulate defensive action and halt broadcast when simulationOnly=true', async () => {
      const streamListener = vi.fn();
      streamBus.publishDefensiveAction = streamListener;

      mockRpc.simulateTransaction.mockResolvedValueOnce({
        _parsed: true,
        minResourceFee: '25000',
        transactionData: new SorobanDataBuilder(),
        result: { auth: [] },
      });

      const policy: ResponseActionPolicy = {
        enabled: true,
        actionType: 'INVOKE_CONTRACT',
        functionName: 'emergency_stop',
        simulationOnly: true,
      };

      const result = await responder.executeDefensiveAction(sampleAlert, policy);

      expect(result.status).toBe('SIMULATED');
      expect(result.simulatedFee).toBe('25000');
      expect(mockRpc.sendTransaction).not.toHaveBeenCalled();
      expect(mockPrisma.actionExecution.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'exec_abc_123' },
          data: expect.objectContaining({ status: 'SIMULATED' }),
        })
      );
      expect(streamListener).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'SIMULATED' })
      );
    });

    it('should broadcast, poll, and confirm on-chain defensive intervention when simulation succeeds', async () => {
      mockRpc.simulateTransaction.mockResolvedValueOnce({
        _parsed: true,
        minResourceFee: '30000',
        transactionData: new SorobanDataBuilder(),
        result: { auth: [] },
      });

      mockRpc.sendTransaction.mockResolvedValueOnce({
        status: 'PENDING',
        hash: 'txhash_circuit_breaker_confirmed',
      });

      mockRpc.getTransaction.mockResolvedValueOnce({
        status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 105432,
      });

      const policy: ResponseActionPolicy = {
        enabled: true,
        actionType: 'INVOKE_CONTRACT',
        functionName: 'pause',
        simulationOnly: false,
      };

      const result = await responder.executeDefensiveAction(sampleAlert, policy);

      expect(result.status).toBe('CONFIRMED');
      expect(result.txHash).toBe('txhash_circuit_breaker_confirmed');
      expect(result.ledgerSequence).toBe(105432n);
      expect(mockRpc.sendTransaction).toHaveBeenCalled();
      expect(mockPrisma.actionExecution.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'exec_abc_123' },
          data: expect.objectContaining({
            status: 'CONFIRMED',
            ledgerSequence: 105432n,
          }),
        })
      );
    });

    it('should fail and abort if simulated transaction reverts', async () => {
      mockRpc.simulateTransaction.mockResolvedValueOnce({
        error: 'Host error: Contract has already been paused',
      });

      const policy: ResponseActionPolicy = {
        enabled: true,
        actionType: 'INVOKE_CONTRACT',
        functionName: 'pause',
      };

      const result = await responder.executeDefensiveAction(sampleAlert, policy);

      expect(result.status).toBe('FAILED');
      expect(result.error).toContain('Contract has already been paused');
      expect(mockRpc.sendTransaction).not.toHaveBeenCalled();
    });

    it('should reject action if simulated fee exceeds maxResourceFee budget', async () => {
      mockRpc.simulateTransaction.mockResolvedValueOnce({
        _parsed: true,
        minResourceFee: '8000000',
        transactionData: new SorobanDataBuilder(),
        result: { auth: [] },
      });

      const policy: ResponseActionPolicy = {
        enabled: true,
        actionType: 'INVOKE_CONTRACT',
        functionName: 'pause',
        maxResourceFee: '5000000',
      };

      const result = await responder.executeDefensiveAction(sampleAlert, policy);

      expect(result.status).toBe('FAILED');
      expect(result.error).toContain('exceeds rule maxResourceFee');
      expect(mockRpc.sendTransaction).not.toHaveBeenCalled();
    });

    it('should support isolated dry-run simulation via simulateDryRun', async () => {
      mockRpc.simulateTransaction.mockResolvedValueOnce({
        _parsed: true,
        minResourceFee: '12000',
        transactionData: new SorobanDataBuilder(),
      });

      const simResult = await responder.simulateDryRun(TEST_CONTRACT_ID, 'pause');

      expect(simResult.success).toBe(true);
      expect(simResult.minResourceFee).toBe('12000');
    });
  });

  describe('Fastify REST API Defender Endpoints', () => {
    let server: FastifyInstance;

    beforeAll(async () => {
      server = await buildServer({ enableLogging: false });
      await server.ready();
    });

    afterAll(async () => {
      await server.close();
    });

    it('should return Guardian status on GET /api/v1/defender/status', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/defender/status',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.publicKey).toMatch(/^G[A-Z0-9]{55}$/);
      expect(typeof body.data.isConfigured).toBe('boolean');
    });

    it('should reject invalid contract ID format on POST /api/v1/defender/simulate', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/defender/simulate',
        payload: {
          contractId: 'invalid-address',
          functionName: 'pause',
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.type).toBe('https://soroban-watchdog.io/errors/validation-error');
    });
  });
});
