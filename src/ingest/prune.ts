import { prisma } from '../db/client.js';
import { createFailedEventManager } from './failedEventManager.js';

/**
 * CLI tool to prune old resolved/discarded events from the FailedEvent quarantine table.
 * Usage: npm run prune-failed-events or tsx src/ingest/prune.ts [--days=14]
 */
export async function pruneFailedEvents(): Promise<void> {
  const failedManager = createFailedEventManager();

  let days = 14;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--days=')) {
      const parsed = parseInt(arg.split('=')[1], 10);
      if (!isNaN(parsed) && parsed > 0) {
        days = parsed;
      }
    }
  }

  console.log(`🧹 [Prune Tool] Pruning resolved/discarded dead-letter events older than ${days} days...`);
  const count = await failedManager.prune(days);
  console.log(`✨ [Prune Tool] Successfully pruned ${count} dead-letter event(s).`);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').includes('src/ingest/prune')) {
  pruneFailedEvents()
    .then(async () => {
      await prisma.$disconnect();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('Fatal error during pruning:', err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
