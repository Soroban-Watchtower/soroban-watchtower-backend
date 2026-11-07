import { buildServer } from './server/server.js';
import { createPoller } from './ingest/poller.js';
import { createAlertWorker, createAlertQueue, createCooldownManager } from './queue/index.js';
import { createDefaultNotifierRegistry } from './notifiers/index.js';
import { createDetectorRunner, DatabaseEventHistoryProvider } from './detectors/index.js';
import { decrypt } from './db/encryption.js';
import { ChannelType } from './types/index.js';
import { config } from './config/env.js';
import { logger } from './observability/logger.js';
import { shutdownManager } from './observability/shutdown.js';
import { prisma } from './db/client.js';

/**
 * Unified Bootstrap: Initializes the dual-engine single-process architecture.
 * 1. Checks PostgreSQL & Redis readiness.
 * 2. Starts Ingestion Poller with event persistence hook wired to DetectorRunner.
 * 3. Starts Alert Queue Worker with registered Notifier plugins.
 * 4. Starts Fastify HTTP Read API server with Swagger and Prometheus telemetry.
 * 5. Registers ordered graceful shutdown hooks.
 */
export async function bootstrap(): Promise<void> {
  console.log(`
  ==============================================================
   🛡️  SOROBAN WATCHDOG - TELEMETRY & SECURITY SURVEILLANCE
  ==============================================================
  `);

  logger.info({ env: config.NODE_ENV, port: config.PORT }, '[Bootstrap] Initializing subsystems...');

  // 1. Verify Database Connectivity
  try {
    await prisma.$queryRaw`SELECT 1`;
    logger.info('[Bootstrap] Database connection verified.');
  } catch (dbErr: any) {
    logger.error({ dbErr }, `[Bootstrap] Failed to connect to PostgreSQL: ${dbErr.message}`);
    process.exit(1);
  }

  // 2. Initialize Queue, Cooldown, and Detector Subsystems
  const alertQueue = createAlertQueue();
  const cooldownManager = createCooldownManager();
  const eventHistoryProvider = new DatabaseEventHistoryProvider(prisma);

  const detectorRunner = createDetectorRunner({
    prismaClient: prisma,
    eventHistoryProvider,
    onAlert: async (alertPayload) => {
      // 1. Sliding Cooldown & Deduplication Gate
      const cooldown = await cooldownManager.shouldDispatch(
        alertPayload.contractId,
        alertPayload.ruleId
      );

      if (!cooldown.shouldDispatch) {
        logger.warn(
          {
            contractId: alertPayload.contractId,
            ruleId: alertPayload.ruleId,
            suppressedCount: cooldown.suppressedCount,
          },
          '[AlertBridge] Alert throttled by cooldown fatigue defense'
        );
        return;
      }

      // 2. Query configured channels for this rule
      let ruleChannels: Array<{
        channel: { id: string; type: any; destination: string; secret: string | null };
      }> = [];

      try {
        ruleChannels = await prisma.ruleChannel.findMany({
          where: { ruleId: alertPayload.ruleId },
          include: { channel: true },
        });
      } catch (dbErr: any) {
        logger.error(
          { dbErr, ruleId: alertPayload.ruleId },
          '[AlertBridge] Failed to fetch channels for rule:'
        );
      }

      // 3. Multi-Channel Fan-Out with Credential Decryption
      if (ruleChannels.length > 0) {
        const targets = ruleChannels.map((rc) => {
          let destination = rc.channel.destination;
          let secret = rc.channel.secret || undefined;

          try {
            destination = decrypt(rc.channel.destination);
          } catch {
            // fallback to plaintext if not encrypted
          }

          if (secret) {
            try {
              secret = decrypt(secret);
            } catch {
              // fallback to plaintext
            }
          }

          return {
            channelId: rc.channel.id,
            channelType: rc.channel.type as ChannelType,
            destination,
            secret,
          };
        });

        logger.info(
          { alertId: alertPayload.alertId, channelCount: targets.length },
          `[AlertBridge] Fanning out alert to ${targets.length} channel(s)`
        );

        await alertQueue.enqueueAlertForChannels(alertPayload, targets);
      } else {
        // Fallback: enqueue default job record if rule has no explicit channels bound
        logger.info(
          { alertId: alertPayload.alertId },
          '[AlertBridge] No external channels bound to rule; enqueueing default delivery record'
        );
        await alertQueue.enqueueAlert({
          alertId: alertPayload.alertId,
          payload: alertPayload,
        });
      }
    },
  });

  // 3. Initialize & Start Ingestion Poller
  const poller = createPoller({
    prismaClient: prisma,
    dynamicSync: true,
    shardCount: 2,
    batchChunkSize: 5,
    onEventsPersisted: async (contractId, events) => {
      for (const event of events) {
        try {
          await detectorRunner.evaluateEvent(event);
        } catch (detectorErr: any) {
          logger.error({ detectorErr, eventId: event.id }, '[Poller] Error evaluating detector:');
        }
      }
    },
  });

  // 4. Initialize & Start Alert Worker with Notifiers
  const notifiers = createDefaultNotifierRegistry();
  const alertWorker = createAlertWorker({
    notifiers,
    prismaClient: prisma,
  });

  // 5. Initialize Fastify HTTP Read API
  const server = await buildServer({ enableLogging: true });

  // 6. Register Ordered Graceful Shutdown Tasks
  // Order 10: Stop Ingestion Poller
  shutdownManager.addTask('Halt Ingestion Poller', 10, async () => {
    logger.info('[Shutdown] Halting Ingestion Poller...');
    poller.stop();
  });

  // Order 20: Close Alert Worker & Queue
  shutdownManager.addTask('Drain Alert Worker & Queue', 20, async () => {
    logger.info('[Shutdown] Closing Alert Worker and Queue...');
    await alertWorker.close();
    await alertQueue.close();
  });

  // Order 30: Close Fastify HTTP Server
  shutdownManager.addTask('Close Fastify HTTP Listener', 30, async () => {
    logger.info('[Shutdown] Closing Fastify HTTP listener...');
    await server.close();
  });

  // Listen for termination signals (SIGINT / SIGTERM)
  shutdownManager.listen();

  // 7. Start Services
  const address = await server.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info(`🚀 Fastify REST API ready at ${address}`);
  logger.info(`📖 Interactive API documentation at ${address}/docs`);
  logger.info(`📊 Prometheus metrics available at ${address}/metrics`);

  // Start background poller loop asynchronously
  poller.start().catch((pollerErr: any) => {
    logger.error({ pollerErr }, `[Poller] Fatal error in poller loop: ${pollerErr.message}`);
  });

  logger.info('✨ Soroban Watchdog dual-engine single-process runtime is operational.');
}

// Auto-run if executed as main module
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('src/index.ts')) {
  bootstrap().catch((err) => {
    console.error('Fatal bootstrap error:', err);
    process.exit(1);
  });
}
