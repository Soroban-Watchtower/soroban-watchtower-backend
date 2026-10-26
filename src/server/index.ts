import { buildServer } from './server.js';
import { config } from '../config/env.js';
import { logger } from '../observability/logger.js';
import { shutdownManager } from '../observability/shutdown.js';

export async function startServer(): Promise<void> {
  const server = await buildServer({ enableLogging: true });

  // Register shutdown step 30 (Stop HTTP server)
  shutdownManager.addTask('Close Fastify HTTP Server', 30, async () => {
    logger.info('[Server] Closing Fastify HTTP listener...');
    await server.close();
  });

  shutdownManager.listen();

  try {
    const address = await server.listen({ port: config.PORT, host: '0.0.0.0' });
    logger.info(`🚀 Fastify REST API server listening at ${address}`);
    logger.info(`📖 Interactive OpenAPI documentation available at ${address}/docs`);
    logger.info(`📊 Prometheus metrics exporter available at ${address}/metrics`);
  } catch (err: any) {
    logger.error({ err }, `[Server] Fatal error starting server: ${err.message}`);
    process.exit(1);
  }
}

// Auto-run if executed directly via CLI
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').includes('src/server/index')) {
  startServer();
}

export * from './server.js';
