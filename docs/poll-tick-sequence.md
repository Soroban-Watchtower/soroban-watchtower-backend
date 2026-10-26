# ⏱️ Poll-Tick Sequence & Ingestion Pipeline

This document explains the internal execution loop of the **Ingestion Poller** (`src/ingest/poller.ts`), detailing cursor tracking, atomic database transactions, backlog fast-forwarding, and Prometheus metric emissions.

---

## 1. Sequence Diagram

```mermaid
sequenceDiagram
    autonumber
    participant Loop as Poller Loop
    participant CM as CursorManager
    participant RPC as Soroban RPC Node
    participant Dec as EventDecoder
    participant FQ as FailedEventManager
    participant DB as PostgreSQL ($transaction)
    participant Runner as DetectorRunner
    participant Queue as BullMQ AlertQueue
    participant Metric as Prometheus Metrics

    Loop->>CM: getCursor(contractId)
    CM-->>Loop: Return { cursor, lastLedgerSequence, chainLedger }

    alt Cursor Exists
        Loop->>RPC: getEvents(cursor, filters, limit)
    else First Ingestion
        Loop->>RPC: getLatestLedger()
        RPC-->>Loop: Return { sequence }
        Loop->>RPC: getEvents(startLedger = sequence - 100, filters, limit)
    end

    RPC-->>Loop: Return { latestLedger, events[] }
    Loop->>Metric: Set soroban_poller_chain_ledger

    alt Malformed Event in Batch
        Loop->>Dec: decodeSorobanEvent(rawEvent)
        Dec-->>Loop: Throws DecodeError
        Loop->>FQ: recordFailedEvent(rawEvent, error)
        FQ->>DB: Insert into FailedEvent table (status: PENDING)
    else Valid Events Decoded
        Loop->>Dec: decodeSorobanEvent(rawEvent)
        Dec-->>Loop: DecodedSorobanEvent
    end

    alt Events Decoded > 0
        Loop->>DB: Atomic db.$transaction:
        Note over DB: 1. Upsert Contract<br/>2. Batch insert Events (skipDuplicates: true)<br/>3. Upsert IngestionState (cursor, lastLedger, chainLedger, lastEventId)
        DB-->>Loop: Transaction Committed
        Loop->>Runner: onEventsPersisted hook -> evaluateEvent(event)
        alt Rule Triggered
            Runner->>Queue: enqueueAlert(jobData)
            Queue-->>Runner: Job Enqueued (deterministic ID)
        end
    else Zero Events In Batch
        Loop->>DB: updateCursorOnly(cursor, chainLedger)
    end

    Loop->>Metric: Update soroban_poller_lag_ledgers (chainLedger - lastLedger)
    Loop->>Metric: Observe soroban_poller_tick_duration_seconds

    alt Full Batch Returned (hasMore = true)
        Note over Loop: Fast-Forward Immediately: No sleep!
    else Partial Batch Returned (hasMore = false)
        Note over Loop: Sleep for POLL_INTERVAL_MS (e.g. 5000ms)
    end
```

---

## 2. Ingestion Guarantees & Invariants

### 1. Strictly Forward Cursor Advancement
The cursor returned by Soroban RPC (`event.id`) is lexicographically ordered by `{ledgerSequence}-{txIndex}-{eventIndex}`. The poller never moves backwards, guaranteeing events are processed in chronological blockchain order.

### 2. Atomic Dual-State Persistence
Events and cursor updates are committed in a single interactive PostgreSQL transaction (`db.$transaction`). If the process crashes mid-batch:
- Zero partial batches are persisted.
- The cursor remains at the previous state.
- Upon restart, the poller re-requests the batch without data corruption.

### 3. Deduplication Protection
Events are inserted using `createMany` with `skipDuplicates: true`. Even during event replays or RPC cursor overlap, duplicate database insertions are silently discarded via the primary key index.

### 4. Backlog Fast-Forwarding
If the watchdog fell behind during maintenance, `hasMore = true` triggers immediate subsequent polling cycles without waiting for the `POLL_INTERVAL_MS` sleep timer, rapidly catching up to the chain head.
