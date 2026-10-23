# 🔄 Soroban Event Data Pipeline & RPC Ingestion

This document details how raw Stellar blockchain ledgers become actionable security alerts.

---

## 1. Stellar & Soroban RPC Mechanics

Soroban smart contracts emit events during execution using `env.events().publish(topics, data)`.
These events are recorded in the ledger's transaction meta and served via Soroban RPC.

### Official Endpoint:
- **Testnet RPC**: `https://soroban-testnet.stellar.org`
- **Mainnet RPC**: `https://mainnet.sorobanrpc.com` (or provider endpoints like QuickNode / Blockdaemon)

### JSON-RPC Request Format (`getEvents`)
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "getEvents",
  "params": {
    "startLedger": 1234567,
    "filters": [
      {
        "type": "contract",
        "contractIds": ["CA3D52W2QB2UP0KZK2G..."]
      }
    ],
    "pagination": {
      "limit": 100
    }
  }
}
```

### Response Payload Structure
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "events": [
      {
        "id": "0001234567-0000000001-0000000000",
        "contractId": "CA3D52W2QB2UP0KZK2G...",
        "type": "contract",
        "ledger": 1234567,
        "ledgerClosedAt": "2026-10-22T14:00:00Z",
        "txHash": "a1b2c3d4...",
        "topic": ["AAAAEAAAAAEAAAAGZGVwb3NpdAAAAAA=", "AAAAEAAAAAEAAABH..."],
        "value": "AAAAEAAAAAEAAAARAAAAAAAA..."
      }
    ],
    "latestLedger": 1234575,
    "cursor": "0001234567-0000000001-0000000000"
  }
}
```

---

## 2. The 5-Step Ingestion & Alerting Pipeline

```
[Stellar RPC]
      │
      ▼ (Step 1: Poll with Cursor & Filters)
[Raw RPC Ingest]
      │
      ▼ (Step 2: Base64 XDR Decoding to ScVal)
[Domain Event Mapper]
      │
      ▼ (Step 3: Atomic Database Transaction: Events + Cursor)
[PostgreSQL]
      │
      ▼ (Step 4: Realtime Rule Engine: Stateless & Windowed)
[Detectors] ──(Anomaly Detected)──► [BullMQ Alert Queue]
                                           │
                                           ▼ (Step 5: Dispatch & Retry)
                                    [Notifiers (Discord/Telegram/Webhook)]
```

### Step 1: Cursor-Based Polling Loop
1. Worker queries database table `ingestion_state` for `cursor` of contract.
2. If `cursor` exists, call `getEvents({ pagination: { cursor } })`.
   *(Notice: `startLedger` must NOT be supplied when `cursor` is provided)*.
3. If no cursor exists (newly registered contract), call `getEvents({ startLedger: currentLedger - 100 })`.
4. RPC returns events strictly ordered by ID ascending.
5. If response contains full page (`limit` reached), poll immediately; otherwise, wait `ledgerCloseTime` (~5 seconds).

### Step 2: XDR Decoding & ScVal Parsing
Raw Soroban topics and data are base64-encoded Stellar XDR.
The decoder uses `@stellar/stellar-sdk`'s `xdr.ScVal.fromXDR(base64, 'base64')`:
- **Address**: `scvAddress` -> decoded to `C...` (Contract) or `G...` (Account) address string.
- **Symbol**: `scvSymbol` -> decoded to utf-8 string (e.g. `"deposit"`, `"withdraw"`, `"emergency_pause"`).
- **Integers & Decimals**:
  - `scvI128` / `scvU128` are converted to JavaScript `BigInt`.
  - Token amounts are represented in base units (stroops/sub-units).
  - Example: `100.50 USDC` (7 decimals) is stored and evaluated as `1005000000n`.
  - **Zero floating-point math** is allowed in rule evaluation to prevent rounding vulnerabilities.

### Step 3: Atomic Persistence & Gap Detection
- Ingestion writes events to `Event` table using `INSERT ... ON CONFLICT (id) DO NOTHING`.
- Updates `IngestionState.cursor` in the same database transaction.
- **Gap Detection**: Soroban RPC response includes `oldestLedger`. If our `lastLedgerSequence` is strictly less than `oldestLedger`, an ingestion gap has occurred (e.g. node pruned ledgers during worker maintenance). An administrative alert is automatically logged.

### Step 4: Rule Engine Evaluation
Every parsed event is passed through registered rules:
- **Stateless Rules**: Compare values in single event (e.g., `amount > rule.threshold`).
- **Windowed Rules**: Query PostgreSQL for cumulative metrics over `windowSeconds` (e.g., `SELECT count(*) FROM Event WHERE contractId = $1 AND createdAt > NOW() - INTERVAL '5 minutes'`).
- If matched, an `Alert` record is persisted.

### Step 5: BullMQ Queue & Resilient Dispatch
- An alert job is pushed to Redis queue `alerts-dispatch`.
- Worker picks up job, fetches configured channels, decrypts secrets, and invokes target notifiers.
- Automatic retries with exponential backoff on network failures.
