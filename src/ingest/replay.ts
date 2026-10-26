import { prisma } from '../db/client.js';
import { createFailedEventManager } from './failedEventManager.js';
import { decodeSorobanEvent } from '../decoder/eventDecoder.js';
import { createCursorManager } from './cursorManager.js';
import { logger } from '../observability/logger.js';

/**
 * CLI tool to replay dead-lettered events from the FailedEvent quarantine table.
 * Usage: npm run replay-failed-events or tsx src/ingest/replay.ts
 */
export async function replayFailedEvents(batchSize: number = 50): Promise<void> {
  const failedManager = createFailedEventManager();
  const cursorManager = createCursorManager();

  console.log('🔄 [Replay Tool] Inspecting dead-letter quarantine table for PENDING items...');
  const pending = await failedManager.getPendingFailedEvents(batchSize);

  if (pending.length === 0) {
    console.log('✨ [Replay Tool] No pending failed events found in quarantine.');
    return;
  }

  console.log(`📦 [Replay Tool] Found ${pending.length} failed event(s). Starting replay...`);
  let successCount = 0;
  let failCount = 0;

  for (const item of pending) {
    try {
      // Attempt to decode the raw payload
      const rawPayload = item.rawPayload as any;
      const decoded = decodeSorobanEvent(rawPayload, { contractId: item.contractId });

      // Save event atomically
      await cursorManager.saveEventsAndCursor(
        item.contractId,
        [decoded],
        decoded.id,
        decoded.ledger
      );

      await failedManager.markResolved(item.id);
      successCount++;
      console.log(`  ✅ Successfully reprocessed & resolved event ${item.eventId || item.id}`);
    } catch (err: any) {
      failCount++;
      await failedManager.recordReplayFailure(item.id, err);
      console.error(`  ❌ Failed to replay event ${item.eventId || item.id}: ${err.message}`);
    }
  }

  console.log(
    `🏁 [Replay Tool] Summary: ${successCount} resolved, ${failCount} failed (retry counter incremented).`
  );
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').includes('src/ingest/replay')) {
  replayFailedEvents()
    .then(async () => {
      await prisma.$disconnect();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('Fatal error during replay:', err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
