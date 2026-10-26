import { logger } from './logger.js';
import { disconnectPrisma } from '../db/client.js';

export interface ShutdownTask {
  name: string;
  order: number;
  fn: () => Promise<void> | void;
}

export class GracefulShutdownManager {
  private tasks: ShutdownTask[] = [];
  private isShuttingDown = false;
  private timeoutMs: number;

  constructor(timeoutMs: number = 15000) {
    this.timeoutMs = timeoutMs;
  }

  /**
   * Registers a shutdown handler with execution order.
   * Lower numbers execute earlier (e.g. 10: stop poller, 20: stop worker, 30: stop server, 40: drain db).
   */
  addTask(name: string, order: number, fn: () => Promise<void> | void): void {
    this.tasks.push({ name, order, fn });
    this.tasks.sort((a, b) => a.order - b.order);
  }

  /**
   * Executes all registered shutdown tasks in sequential priority order.
   */
  async shutdown(signal: string = 'SIGTERM'): Promise<void> {
    if (this.isShuttingDown) {
      logger.warn({ signal }, '[Shutdown] Shutdown already in progress. Ignoring duplicate signal.');
      return;
    }
    this.isShuttingDown = true;

    logger.info({ signal }, `[Shutdown] Graceful shutdown sequence initiated via ${signal}...`);

    const timeoutTimer = setTimeout(() => {
      logger.error(`[Shutdown] Forceful termination triggered: sequence timed out after ${this.timeoutMs}ms.`);
      process.exit(1);
    }, this.timeoutMs);

    // Don't prevent event loop exit if all tasks finish early
    if (timeoutTimer.unref) {
      timeoutTimer.unref();
    }

    for (const task of this.tasks) {
      try {
        logger.info(`[Shutdown] Executing step ${task.order}: ${task.name}...`);
        await Promise.resolve(task.fn());
        logger.info(`[Shutdown] Step ${task.order} completed: ${task.name}`);
      } catch (err: any) {
        logger.error({ err }, `[Shutdown] Error in step ${task.order} (${task.name}): ${err.message}`);
      }
    }

    clearTimeout(timeoutTimer);
    logger.info('[Shutdown] All subsystems shut down cleanly. Exiting.');
  }

  /**
   * Attaches SIGINT and SIGTERM listeners to the Node process.
   */
  listen(): void {
    const handler = (sig: string) => {
      this.shutdown(sig)
        .then(() => process.exit(0))
        .catch((err) => {
          logger.error({ err }, '[Shutdown] Uncaught error during shutdown sequence:');
          process.exit(1);
        });
    };

    process.once('SIGINT', () => handler('SIGINT'));
    process.once('SIGTERM', () => handler('SIGTERM'));
  }
}

export const shutdownManager = new GracefulShutdownManager();

// Automatically register the database disconnection at order 90 (last)
shutdownManager.addTask('Drain PostgreSQL Database Pool', 90, async () => {
  await disconnectPrisma();
});
