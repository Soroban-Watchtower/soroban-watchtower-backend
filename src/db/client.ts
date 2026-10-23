import { PrismaClient } from '@prisma/client';
import { config } from '../config/env';

/**
 * Global declaration to preserve PrismaClient instance across hot module reloads in development.
 */
declare global {
  // eslint-disable-next-line no-var
  var __prismaClient: PrismaClient | undefined;
}

/**
 * Creates and configures a PrismaClient instance with custom logging.
 */
export function createPrismaClient(): PrismaClient {
  const isDebug = config.LOG_LEVEL === 'debug';

  const client = new PrismaClient({
    log: isDebug
      ? [
          { emit: 'stdout', level: 'query' },
          { emit: 'stdout', level: 'info' },
          { emit: 'stdout', level: 'warn' },
          { emit: 'stdout', level: 'error' },
        ]
      : [
          { emit: 'stdout', level: 'warn' },
          { emit: 'stdout', level: 'error' },
        ],
    datasources: {
      db: {
        url: config.DATABASE_URL,
      },
    },
  });

  return client;
}

/**
 * Singleton Prisma database client instance.
 */
export const prisma: PrismaClient =
  global.__prismaClient ?? (global.__prismaClient = createPrismaClient());

/**
 * Helper to gracefully disconnect Prisma client on application shutdown.
 */
export async function disconnectPrisma(): Promise<void> {
  if (global.__prismaClient) {
    await global.__prismaClient.$disconnect();
  }
}

export default prisma;
