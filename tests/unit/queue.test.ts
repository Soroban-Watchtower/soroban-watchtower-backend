import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AlertQueueProducer,
  DEFAULT_ALERT_QUEUE_NAME,
  DEFAULT_ALERT_JOB_OPTIONS,
  generateAlertJobId,
  parseRedisConnection,
  AlertJobData,
} from '../../src/queue/alertQueue.js';
import {
  AlertWorkerConsumer,
  AlertWorkerOptions,
} from '../../src/queue/alertWorker.js';
import { AlertPayload, DeliveryResult, NotifierPlugin } from '../../src/types/index.js';

describe('BullMQ Alert Queue & Worker Subsystem (src/queue)', () => {
  const dummyAlertPayload: AlertPayload = {
    alertId: 'alert-uuid-1234',
    contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
    ruleId: 'rule-uuid-5678',
    severity: 'HIGH',
    title: 'Large Transfer Detected',
    message: 'Transfer of 1000000 exceeded threshold',
    timestamp: new Date('2026-10-25T12:00:00Z'),
    metadata: { amount: '1000000', threshold: '500000' },
    explorerUrl: 'https://stellar.expert/explorer/testnet/tx/abcdef',
  };

  describe('1. Deterministic Job ID & Redis Configuration', () => {
    it('should generate deterministic Job IDs preventing race condition duplicates', () => {
      const singleId = generateAlertJobId('alert-100');
      expect(singleId).toBe('alert_alert-100');

      const channelId = generateAlertJobId('alert-100', 'channel-discord');
      expect(channelId).toBe('alert_alert-100_channel_channel-discord');
    });

    it('should parse Redis connection and enforce maxRetriesPerRequest: null', () => {
      const conn = parseRedisConnection('redis://user:pass@127.0.0.1:6380');
      expect(conn.host).toBe('127.0.0.1');
      expect(conn.port).toBe(6380);
      expect(conn.username).toBe('user');
      expect(conn.password).toBe('pass');
      expect(conn.maxRetriesPerRequest).toBeNull();
    });

    it('should default to 5 attempts with 1000ms exponential backoff', () => {
      expect(DEFAULT_ALERT_JOB_OPTIONS.attempts).toBe(5);
      expect(DEFAULT_ALERT_JOB_OPTIONS.backoff).toEqual({
        type: 'exponential',
        delay: 1000,
      });
    });
  });

  describe('2. AlertQueueProducer', () => {
    let mockUnderlyingQueue: any;
    let producer: AlertQueueProducer;

    beforeEach(() => {
      mockUnderlyingQueue = {
        add: vi.fn().mockImplementation((name, data, opts) =>
          Promise.resolve({
            id: opts.jobId,
            name,
            data,
            opts,
          })
        ),
        getWaitingCount: vi.fn().mockResolvedValue(2),
        getActiveCount: vi.fn().mockResolvedValue(1),
        getCompletedCount: vi.fn().mockResolvedValue(50),
        getFailedCount: vi.fn().mockResolvedValue(3),
        getDelayedCount: vi.fn().mockResolvedValue(0),
        pause: vi.fn().mockResolvedValue(undefined),
        resume: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };

      producer = new AlertQueueProducer({
        underlyingQueue: mockUnderlyingQueue,
      });
    });

    it('should enqueue alert with deterministic jobId and default retry options', async () => {
      const jobData: AlertJobData = {
        alertId: 'alert-123',
        channelId: 'chan-456',
        channelType: 'DISCORD',
        destination: 'https://discord.com/api/webhooks/123/xyz',
        payload: dummyAlertPayload,
      };

      const job = await producer.enqueueAlert(jobData);

      expect(mockUnderlyingQueue.add).toHaveBeenCalledTimes(1);
      expect(mockUnderlyingQueue.add).toHaveBeenCalledWith(
        'dispatch-alert',
        expect.objectContaining({
          alertId: 'alert-123',
          channelId: 'chan-456',
        }),
        expect.objectContaining({
          jobId: 'alert_alert-123_channel_chan-456',
          attempts: 5,
          backoff: { type: 'exponential', delay: 1000 },
        })
      );
      expect(job.id).toBe('alert_alert-123_channel_chan-456');
    });

    it('should fan-out alerts to multiple channels with separate deterministic job IDs', async () => {
      const channels = [
        {
          channelId: 'ch-discord',
          channelType: 'DISCORD' as const,
          destination: 'https://discord.com/webhook',
        },
        {
          channelId: 'ch-telegram',
          channelType: 'TELEGRAM' as const,
          destination: '-1001234567890',
          secret: 'bot-token',
        },
      ];

      const jobs = await producer.enqueueAlertForChannels(dummyAlertPayload, channels);

      expect(jobs).toHaveLength(2);
      expect(mockUnderlyingQueue.add).toHaveBeenCalledTimes(2);

      expect(mockUnderlyingQueue.add).toHaveBeenNthCalledWith(
        1,
        'dispatch-alert',
        expect.objectContaining({ channelId: 'ch-discord' }),
        expect.objectContaining({ jobId: 'alert_alert-uuid-1234_channel_ch-discord' })
      );

      expect(mockUnderlyingQueue.add).toHaveBeenNthCalledWith(
        2,
        'dispatch-alert',
        expect.objectContaining({ channelId: 'ch-telegram' }),
        expect.objectContaining({ jobId: 'alert_alert-uuid-1234_channel_ch-telegram' })
      );
    });

    it('should provide queue observability metrics', async () => {
      const metrics = await producer.getMetrics();
      expect(metrics).toEqual({
        waiting: 2,
        active: 1,
        completed: 50,
        failed: 3,
        delayed: 0,
      });
    });

    it('should pause, resume, and close the queue', async () => {
      await producer.pause();
      expect(mockUnderlyingQueue.pause).toHaveBeenCalledTimes(1);

      await producer.resume();
      expect(mockUnderlyingQueue.resume).toHaveBeenCalledTimes(1);

      await producer.close();
      expect(mockUnderlyingQueue.close).toHaveBeenCalledTimes(1);
    });
  });

  describe('3. AlertWorkerConsumer Processing & Retry Mechanics', () => {
    let mockUnderlyingWorker: any;

    beforeEach(() => {
      mockUnderlyingWorker = {
        on: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      };
    });

    it('should process job successfully and return delivery result', async () => {
      const dispatcherSpy = vi.fn().mockResolvedValue({
        success: true,
        statusCode: 200,
        sentAt: new Date(),
      });

      const consumer = new AlertWorkerConsumer({
        underlyingWorker: mockUnderlyingWorker,
        dispatcher: dispatcherSpy,
      });

      const mockJob: any = {
        id: 'job-1',
        attemptsMade: 0,
        data: {
          alertId: 'alert-1',
          channelId: 'chan-1',
          channelType: 'DISCORD',
          destination: 'https://discord.com/webhook',
          payload: dummyAlertPayload,
        },
      };

      const result = await consumer.processJob(mockJob);

      expect(dispatcherSpy).toHaveBeenCalledTimes(1);
      expect(dispatcherSpy).toHaveBeenCalledWith(mockJob.data);
      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
    });

    it('should dispatch to registered NotifierPlugin matching channelType', async () => {
      const mockDiscordPlugin: NotifierPlugin = {
        type: 'DISCORD',
        send: vi.fn().mockResolvedValue({
          success: true,
          statusCode: 204,
          sentAt: new Date(),
        }),
      };

      const notifiers = new Map([['DISCORD', mockDiscordPlugin]]);

      const consumer = new AlertWorkerConsumer({
        underlyingWorker: mockUnderlyingWorker,
        notifiers: notifiers as any,
      });

      const mockJob: any = {
        id: 'job-2',
        attemptsMade: 0,
        data: {
          alertId: 'alert-2',
          channelType: 'DISCORD',
          destination: 'https://discord.com/api/webhooks/999/xyz',
          secret: undefined,
          payload: dummyAlertPayload,
        },
      };

      const result = await consumer.processJob(mockJob);

      expect(mockDiscordPlugin.send).toHaveBeenCalledWith(
        dummyAlertPayload,
        'https://discord.com/api/webhooks/999/xyz',
        undefined
      );
      expect(result.success).toBe(true);
    });

    it('should throw an Error when delivery fails to trigger BullMQ retry up to 5 times', async () => {
      const failingDispatcher = vi.fn().mockResolvedValue({
        success: false,
        statusCode: 500,
        error: 'Discord API Rate Limited (HTTP 429)',
        sentAt: new Date(),
      });

      const consumer = new AlertWorkerConsumer({
        underlyingWorker: mockUnderlyingWorker,
        dispatcher: failingDispatcher,
      });

      const mockJob: any = {
        id: 'job-fail',
        attemptsMade: 2, // 3rd attempt
        data: {
          alertId: 'alert-fail',
          channelId: 'chan-fail',
          channelType: 'DISCORD',
          payload: dummyAlertPayload,
        },
      };

      // Must throw so BullMQ marks job as failed and schedules exponential backoff
      await expect(consumer.processJob(mockJob)).rejects.toThrow(
        'Discord API Rate Limited (HTTP 429)'
      );
    });

    it('should record delivery attempts in Prisma when database client is supplied', async () => {
      const mockPrisma = {
        alertDelivery: {
          create: vi.fn().mockResolvedValue({ id: 'delivery-1' }),
        },
      } as any;

      const consumer = new AlertWorkerConsumer({
        underlyingWorker: mockUnderlyingWorker,
        prismaClient: mockPrisma,
        dispatcher: vi.fn().mockResolvedValue({
          success: true,
          sentAt: new Date('2026-10-25T13:00:00Z'),
        }),
      });

      const mockJob: any = {
        id: 'job-db',
        attemptsMade: 0,
        data: {
          alertId: 'alert-db',
          channelId: 'chan-db',
          payload: dummyAlertPayload,
        },
      };

      await consumer.processJob(mockJob);

      expect(mockPrisma.alertDelivery.create).toHaveBeenCalledWith({
        data: {
          alertId: 'alert-db',
          channelId: 'chan-db',
          status: 'DELIVERED',
          attempts: 1,
          sentAt: expect.any(Date),
          lastError: null,
        },
      });
    });

    it('should record delivery failures in Prisma before throwing retry error', async () => {
      const mockPrisma = {
        alertDelivery: {
          create: vi.fn().mockResolvedValue({ id: 'delivery-fail' }),
        },
      } as any;

      const consumer = new AlertWorkerConsumer({
        underlyingWorker: mockUnderlyingWorker,
        prismaClient: mockPrisma,
        dispatcher: vi.fn().mockResolvedValue({
          success: false,
          error: 'Webhook timeout',
        }),
      });

      const mockJob: any = {
        id: 'job-fail-db',
        attemptsMade: 1, // 2nd attempt
        data: {
          alertId: 'alert-fail-db',
          channelId: 'chan-fail-db',
          payload: dummyAlertPayload,
        },
      };

      await expect(consumer.processJob(mockJob)).rejects.toThrow('Webhook timeout');

      expect(mockPrisma.alertDelivery.create).toHaveBeenCalledWith({
        data: {
          alertId: 'alert-fail-db',
          channelId: 'chan-fail-db',
          status: 'FAILED',
          attempts: 2,
          lastError: 'Webhook timeout',
        },
      });
    });
  });

  describe('4. Full End-to-End Producer -> Worker Processing Flow', () => {
    it('should enqueue and process an alert job maintaining data fidelity', async () => {
      let capturedJobData: AlertJobData | null = null;
      let capturedJobOptions: any = null;

      const mockQueue: any = {
        add: vi.fn().mockImplementation((_name, data, opts) => {
          capturedJobData = data;
          capturedJobOptions = opts;
          return Promise.resolve({
            id: opts.jobId,
            data,
            attemptsMade: 0,
          });
        }),
      };

      const producer = new AlertQueueProducer({
        underlyingQueue: mockQueue,
      });

      const processedEvents: AlertJobData[] = [];
      const consumer = new AlertWorkerConsumer({
        underlyingWorker: { on: vi.fn(), close: vi.fn() } as any,
        dispatcher: async (jobData) => {
          processedEvents.push(jobData);
          return { success: true, sentAt: new Date() };
        },
      });

      // 1. Producer enqueues alert
      const enqueuedJob = await producer.enqueueAlert({
        alertId: 'e2e-alert-1',
        channelId: 'e2e-channel-discord',
        channelType: 'DISCORD',
        destination: 'https://discord.com/api/webhooks/xyz',
        payload: dummyAlertPayload,
      });

      expect(enqueuedJob.id).toBe('alert_e2e-alert-1_channel_e2e-channel-discord');
      expect(capturedJobOptions.attempts).toBe(5);

      // 2. Worker processes the simulated job
      const processResult = await consumer.processJob(enqueuedJob as any);

      expect(processResult.success).toBe(true);
      expect(processedEvents).toHaveLength(1);
      expect(processedEvents[0].payload.title).toBe('Large Transfer Detected');
      expect(processedEvents[0].destination).toBe('https://discord.com/api/webhooks/xyz');
    });
  });
});
