# 📡 Ingestion Worker Subsystem (`src/ingest/`)

## Architecture & Responsibilities
- The heartbeat of Soroban Watchdog. Runs as a continuous, asynchronous worker daemon.
- Connects to the Soroban RPC node via `@stellar/stellar-sdk`'s `rpc.Server`.
- Implements cursor-based pagination using the RPC `getEvents` method.

## Critical Invariants & Rules
1. **Never Skip Ledgers**: The ingestion loop reads from the last recorded cursor in `ingestion_state`.
2. **Never Process Out of Order**: Stellar RPC returns events in ascending order of their event ID (`ledger-tx_idx-event_idx`). Events must be processed in this exact sequence.
3. **Atomic Persistence**:
   ```typescript
   await prisma.$transaction([
     prisma.event.createMany({ data: decodedEvents, skipDuplicates: true }),
     prisma.ingestionState.upsert({ ... })
   ]);
   ```
4. **Resilience & Backoff**:
   - If the RPC returns `429 Too Many Requests` or `5xx Server Error`, the worker employs exponential backoff with jitter (1s, 2s, 4s, 8s, up to max 30s).
   - If the RPC returns an `oldestLedger` greater than our current cursor, an ingestion gap has occurred (RPC history pruned). The worker logs a critical audit log and triggers a gap event.
5. **Separate Process Execution**: The ingestion worker can be run as a standalone worker process (`npm run worker:ingest`), decoupled from the HTTP API server.
