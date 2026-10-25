import { Worker, Job, WorkerOptions } from 'bullmq';
import { prisma as defaultPrisma } from '../db/client.js';
import {
  AlertPayload,
  ChannelType,
  DeliveryResult,
  NotifierPlugin,
} from '../types/index.js';
import {
  DEFAULT_ALERT_QUEUE_NAME,
  AlertJobData,
  parseRedisConnection,
} from './alertQueue.js';

export type AlertDispatcher = (data: AlertJobData) => Promise<DeliveryResult>;

export interface AlertWorkerOptions {
  queueName?: string;
  connection?: any;
  concurrency?: number;
  prismaClient?: typeof defaultPrisma;
  dispatcher?: AlertDispatcher;
  notifiers?: Map<ChannelType, NotifierPlugin>;
  underlyingWorker?: Worker<AlertJobData, DeliveryResult>;
}

/**
 * AlertWorkerConsumer
 *
 * BullMQ worker that processes asynchronous alert dispatch jobs,
 * sends notifications via registered channel plugins, tracks delivery attempts,
 * and retries up to 5 times with exponential backoff on failure.
 */
export class AlertWorkerConsumer {
  readonly worker: Worker<AlertJobData, DeliveryResult>;
  readonly queueName: string;
  private readonly prismaClient?: typeof defaultPrisma;
  private readonly dispatcher?: AlertDispatcher;
  private readonly notifiers?: Map<ChannelType, NotifierPlugin>;

  constructor(options: AlertWorkerOptions = {}) {
    this.queueName = options.queueName || DEFAULT_ALERT_QUEUE_NAME;
    this.prismaClient = options.prismaClient;
    this.dispatcher = options.dispatcher;
    this.notifiers = options.notifiers;

    if (options.underlyingWorker) {
      this.worker = options.underlyingWorker;
    } else {
      const connection = options.connection || parseRedisConnection();
      const workerOptions: WorkerOptions = {
        connection,
        concurrency: options.concurrency || 5,
      };

      this.worker = new Worker<AlertJobData, DeliveryResult>(
        this.queueName,
        async (job: Job<AlertJobData>) => this.processJob(job),
        workerOptions
      );

      this.setupListeners();
    }
  }

  /**
   * Sets up logging and monitoring event listeners on BullMQ worker.
   */
  private setupListeners(): void {
    this.worker.on('completed', (job: Job<AlertJobData>, result: DeliveryResult) => {
      console.log(
        `[AlertWorker] Job ${job.id} completed successfully (Alert: ${job.data.alertId}, Channel: ${job.data.channelId || 'default'})`
      );
    });

    this.worker.on('failed', (job: Job<AlertJobData> | undefined, err: Error) => {
      const attemptsMade = job?.attemptsMade ?? 0;
      const maxAttempts = job?.opts?.attempts ?? 5;
      console.error(
        `[AlertWorker] Job ${job?.id} failed on attempt ${attemptsMade}/${maxAttempts}: ${err.message}`
      );
    });

    this.worker.on('error', (err: Error) => {
      console.error('[AlertWorker] Worker error event:', err);
    });
  }

  /**
   * Core job processing logic: dispatches to channel and manages delivery record.
   */
  async processJob(job: Job<AlertJobData>): Promise<DeliveryResult> {
    const { data } = job;
    const attempt = job.attemptsMade + 1;

    let deliveryResult: DeliveryResult;

    try {
      // 1. Dispatch via custom dispatcher if provided
      if (this.dispatcher) {
        deliveryResult = await this.dispatcher(data);
      }
      // 2. Dispatch via registered notifier plugin if available
      else if (data.channelType && this.notifiers?.has(data.channelType)) {
        const plugin = this.notifiers.get(data.channelType)!;
        deliveryResult = await plugin.send(
          data.payload,
          data.destination || '',
          data.secret
        );
      }
      // 3. Default fallback: simulated delivery
      else {
        deliveryResult = {
          success: true,
          statusCode: 200,
          sentAt: new Date(),
        };
      }
    } catch (dispatchError: any) {
      deliveryResult = {
        success: false,
        error: dispatchError?.message ?? String(dispatchError),
        sentAt: new Date(),
      };
    }

    // Update database delivery state if Prisma client is present
    if (this.prismaClient && data.channelId) {
      await this.recordDeliveryAttempt(data.alertId, data.channelId, attempt, deliveryResult);
    }

    // If delivery was not successful, throw an Error to trigger BullMQ's exponential backoff retry
    if (!deliveryResult.success) {
      const errorMessage =
        deliveryResult.error || `Alert delivery failed for job ${job.id} on attempt ${attempt}`;
      throw new Error(errorMessage);
    }

    return deliveryResult;
  }

  /**
   * Persists delivery attempt outcomes to the database.
   */
  private async recordDeliveryAttempt(
    alertId: string,
    channelId: string,
    attemptCount: number,
    result: DeliveryResult
  ): Promise<void> {
    try {
      if (result.success) {
        await this.prismaClient!.alertDelivery.create({
          data: {
            alertId,
            channelId,
            status: 'DELIVERED',
            attempts: attemptCount,
            sentAt: result.sentAt,
            lastError: null,
          },
        });
      } else {
        await this.prismaClient!.alertDelivery.create({
          data: {
            alertId,
            channelId,
            status: 'FAILED',
            attempts: attemptCount,
            lastError: result.error ?? 'Unknown delivery failure',
          },
        });
      }
    } catch (dbErr) {
      console.error(
        `[AlertWorker] Failed to record delivery attempt for alert ${alertId} to channel ${channelId}:`,
        dbErr
      );
    }
  }

  /**
   * Gracefully shuts down the BullMQ worker.
   */
  async close(): Promise<void> {
    await this.worker.close();
  }
}

/**
 * Factory function to create an AlertWorkerConsumer.
 */
export function createAlertWorker(options?: AlertWorkerOptions): AlertWorkerConsumer {
  return new AlertWorkerConsumer(options);
}

// Standalone entrypoint for tsx / node execution (e.g. `npm run dev:notify`)
const isDirectExecution =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('alertWorker.ts') || process.argv[1].endsWith('alertWorker.js'));

if (isDirectExecution) {
  console.log('🚀 Initializing Soroban Watchdog Alert Worker...');
  const workerConsumer = createAlertWorker();
  console.log(`📡 Listening for alert jobs on queue: ${workerConsumer.queueName}`);

  const shutdown = async () => {
    console.log('\n🛑 Shutting down Alert Worker...');
    await workerConsumer.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
