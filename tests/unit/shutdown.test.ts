import { describe, it, expect, vi } from 'vitest';
import { GracefulShutdownManager } from '../../src/observability/shutdown.js';

describe('Ordered Graceful Shutdown (src/observability/shutdown)', () => {
  it('should execute registered shutdown tasks sequentially according to priority order', async () => {
    const manager = new GracefulShutdownManager(5000);
    const executionOrder: string[] = [];

    manager.addTask('Drain Database Pool', 40, () => {
      executionOrder.push('step_40_db');
    });

    manager.addTask('Halt Ingestion Poller', 10, () => {
      executionOrder.push('step_10_poller');
    });

    manager.addTask('Close Fastify HTTP Server', 30, () => {
      executionOrder.push('step_30_server');
    });

    manager.addTask('Drain Queue Worker', 20, () => {
      executionOrder.push('step_20_worker');
    });

    await manager.shutdown('SIGTERM');

    expect(executionOrder).toEqual([
      'step_10_poller',
      'step_20_worker',
      'step_30_server',
      'step_40_db',
    ]);
  });

  it('should ignore duplicate shutdown triggers while shutdown is in progress', async () => {
    const manager = new GracefulShutdownManager(5000);
    let runCount = 0;

    manager.addTask('Single Task', 10, () => {
      runCount++;
    });

    await Promise.all([
      manager.shutdown('SIGINT'),
      manager.shutdown('SIGTERM'),
    ]);

    expect(runCount).toBe(1);
  });
});
