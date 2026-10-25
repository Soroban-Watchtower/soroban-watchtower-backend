import { Queue, Job, JobsOptions, QueueOptions } from 'bullmq';
import { config } from '../config/env.js';
import { AlertPayload, ChannelType } from '../types/index.js';

export const DEFAULT_ALERT_QUEUE_NAME = 'soroban-alert-queue';

/**
 * Payload data carried by each alert job in BullMQ.
 */
export interface AlertJobData {
  alertId: string;
  channelId?: string;
  channelType?: ChannelType;
  destination?: string;
  secret?: string;
  payload: AlertPayload;
  queuedAt?: string;
}

/**
 * Optional enqueue overrides.
 */
export interface EnqueueOptions {
  jobId?: string;
  attempts?: number;
  backoffDelayMs?: number;
  priority?: number;
}

/**
 * Standard retry and backoff configuration for alert delivery.
 * Retries up to 5 times with exponential backoff:
 * Attempt 1: 1s, Attempt 2: 2s, Attempt 3: 4s, Attempt 4: 8s, Attempt 5: 16s.
 */
export const DEFAULT_ALERT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: {
    type: 'exponential',
    delay: 1000,
  },
  removeOnComplete: {
    age: 24 * 3600, // retain completed jobs for 24h for auditability
    count: 1000,
  },
  removeOnFail: {
    age: 7 * 24 * 3600, // retain failed jobs for 7 days for diagnostics
  },
};

/**
 * Generates a deterministic BullMQ Job ID.
 * Ensures that even if an alert is evaluated multiple times due to event replays
 * or worker race conditions, BullMQ automatically de-duplicates and ignores duplicates.
 */
export function generateAlertJobId(alertId: string, channelId?: string): string {
  if (channelId) {
    return `alert_${alertId}_channel_${channelId}`;
  }
  return `alert_${alertId}`;
}

/**
 * Extracts connection options for ioredis / BullMQ from the configured REDIS_URL.
 */
export function parseRedisConnection(redisUrl: string = config.REDIS_URL) {
  try {
    const url = new URL(redisUrl);
    return {
      host: url.hostname || '127.0.0.1',
      port: parseInt(url.port || '6379', 10),
      password: url.password || undefined,
      username: url.username || undefined,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    };
  } catch {
    return {
      host: '127.0.0.1',
      port: 6379,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    };
  }
}

export interface AlertQueueOptions {
  queueName?: string;
  connection?: any;
  underlyingQueue?: Queue<AlertJobData>;
}

/**
 * AlertQueueProducer
 *
 * BullMQ producer that pushes alert jobs into Redis with deterministic IDs
 * to guarantee strictly once-only delivery per channel destination.
 */
export class AlertQueueProducer {
  readonly queue: Queue<AlertJobData>;
  readonly queueName: string;

  constructor(options: AlertQueueOptions = {}) {
    this.queueName = options.queueName || DEFAULT_ALERT_QUEUE_NAME;

    if (options.underlyingQueue) {
      this.queue = options.underlyingQueue;
    } else {
      const connection = options.connection || parseRedisConnection();
      const queueOptions: QueueOptions = {
        connection,
        defaultJobOptions: DEFAULT_ALERT_JOB_OPTIONS,
      };
      this.queue = new Queue<AlertJobData>(this.queueName, queueOptions);
    }
  }

  /**
   * Pushes a single alert job into the queue with a deterministic job ID.
   */
  async enqueueAlert(
    jobData: AlertJobData,
    options: EnqueueOptions = {}
  ): Promise<Job<AlertJobData>> {
    const jobId = options.jobId || generateAlertJobId(jobData.alertId, jobData.channelId);

    const jobOptions: JobsOptions = {
      ...DEFAULT_ALERT_JOB_OPTIONS,
      jobId,
      ...(options.attempts ? { attempts: options.attempts } : {}),
      ...(options.backoffDelayMs
        ? { backoff: { type: 'exponential', delay: options.backoffDelayMs } }
        : {}),
      ...(options.priority ? { priority: options.priority } : {}),
    };

    return await this.queue.add(
      'dispatch-alert',
      {
        ...jobData,
        queuedAt: jobData.queuedAt || new Date().toISOString(),
      },
      jobOptions
    );
  }

  /**
   * Fans out an alert payload across multiple destination channels,
   * creating a deterministic job for each channel.
   */
  async enqueueAlertForChannels(
    payload: AlertPayload,
    channels: Array<{
      channelId: string;
      channelType: ChannelType;
      destination: string;
      secret?: string;
    }>
  ): Promise<Job<AlertJobData>[]> {
    const jobs: Job<AlertJobData>[] = [];

    for (const channel of channels) {
      const jobData: AlertJobData = {
        alertId: payload.alertId,
        channelId: channel.channelId,
        channelType: channel.channelType,
        destination: channel.destination,
        secret: channel.secret,
        payload,
      };

      const job = await this.enqueueAlert(jobData);
      jobs.push(job);
    }

    return jobs;
  }

  /**
   * Returns current queue observability metrics.
   */
  async getMetrics(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  }> {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getCompletedCount(),
      this.queue.getFailedCount(),
      this.queue.getDelayedCount(),
    ]);

    return { waiting, active, completed, failed, delayed };
  }

  /**
   * Pauses queue execution.
   */
  async pause(): Promise<void> {
    await this.queue.pause();
  }

  /**
   * Resumes queue execution.
   */
  async resume(): Promise<void> {
    await this.queue.resume();
  }

  /**
   * Closes underlying queue connection.
   */
  async close(): Promise<void> {
    await this.queue.close();
  }
}

/**
 * Factory function to create an AlertQueueProducer.
 */
export function createAlertQueue(options?: AlertQueueOptions): AlertQueueProducer {
  return new AlertQueueProducer(options);
}
