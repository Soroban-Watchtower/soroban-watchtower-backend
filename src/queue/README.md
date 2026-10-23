# ⚡ Queue Subsystem (`src/queue/`)

## Architecture & Responsibilities
- Decouples event detection from alert dispatching using **BullMQ** on **Redis**.
- Guarantees that slow or failing external notification APIs (Discord 429s, Telegram downtime) **never block** the blockchain ingestion pipeline.

## Invariants & Design Principles
1. **Deterministic Job IDs**:
   - Every queued job is assigned a deterministic ID:
     ```typescript
     const jobId = `alert_${alertId}_channel_${channelId}`;
     await alertQueue.add('dispatch-alert', jobData, { jobId });
     ```
   - If a detector evaluates an event twice due to race conditions, BullMQ automatically dedupes and ignores the second job.
2. **Exponential Backoff & Retries**:
   - Failed notifications are retried automatically up to 5 times with exponential backoff:
     - Attempt 1: 1s
     - Attempt 2: 2s
     - Attempt 3: 4s
     - Attempt 4: 8s
     - Attempt 5: 16s
3. **Queue Health & Observability**:
   - Tracks active, waiting, delayed, and failed job counts.
   - Emits alerts if the failed job queue exceeds operational thresholds.
