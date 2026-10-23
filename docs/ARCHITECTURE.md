# 🛡️ Soroban Watchdog: Architecture Blueprint & System Design

Soroban Watchdog is an institutional-grade telemetry, monitoring, and automated exploit-alerting engine for Stellar Soroban smart contracts.

---

## 1. System Overview & Problem Statement

### The Problem in Soroban & Stellar
Soroban smart contracts execute decentralized financial and protocol logic (vaults, automated market makers, lending pools, DAO governance). When deployed:
- Contract state mutations are recorded inside ledger transactions.
- There is **no native push notification** or webhook mechanism on Stellar RPC to alert developers of abnormal behavior.
- Protocol developers are forced to manually inspect block explorers like StellarExpert or Horizon logs.
- Exploits, sudden liquidity drains, protocol pauses, reentrancy-like patterns, and high failure rates can go unnoticed for hours.

### The Watchdog Solution
Soroban Watchdog acts as a resilient, automated surveillance and telemetry daemon:
1. Continuously tracks Stellar Testnet/Mainnet ledgers using the official Soroban RPC `getEvents` and `getTransaction` endpoints.
2. Decodes binary **XDR (External Data Representation)** into strongly typed, human-readable JSON domain events.
3. Persists contract history with strict idempotency and cursor tracking.
4. Evaluates real-time events against user-defined **Stateless Rules** (e.g. single transfer > 10,000 XLM/USDC) and **Stateful Window Rules** (e.g. > 20 failed calls in 60 seconds).
5. Dispatches alerts through **BullMQ (Redis)** to **Discord**, **Telegram**, and **HMAC-signed Webhooks** with zero risk of alerting loops or lost alerts.

---

## 2. High-Level Architecture Diagram

```mermaid
flowchart TD
    subgraph Stellar_Blockchain [Stellar Network / Soroban RPC]
        RPC[Soroban RPC Node\nsoroban-testnet.stellar.org]
    end

    subgraph Ingestion_Pipeline [Ingestion Engine (Worker)]
        Poller[RPC Poller Loop\nLedger / Cursor Sequencer]
        Decoder[XDR Decoder & ScVal Parser]
        GapDetector[Gap & Retention Detector]
    end

    subgraph Storage_Layer [Persistence (PostgreSQL)]
        DB[(PostgreSQL Database)]
        T_Contracts[contracts]
        T_Cursor[ingestion_state]
        T_Events[events]
        T_Rules[rules]
        T_Channels[channels]
        T_Alerts[alerts]
    end

    subgraph Detection_Engine [Rule & Telemetry Evaluator]
        Engine[Rule Evaluator]
        Rule_Stateless[Stateless Rules\nThreshold / Event Type / Pause]
        Rule_Windowed[Windowed Rules\nSpike / Drain Rate / Burst Errors]
    end

    subgraph Dispatch_Queue [Job Queue (Redis + BullMQ)]
        Queue[BullMQ Alert Queue\nDeterministic Job IDs + Exponential Backoff]
    end

    subgraph Notifier_Engine [Notifier Worker Subsystem]
        Dispatcher[Notification Dispatcher]
        Discord[Discord Webhook Notifier]
        Telegram[Telegram Bot Notifier]
        Webhook[Signed HMAC Webhook Notifier]
    end

    subgraph API_Layer [REST API Server (Fastify)]
        API[Fastify HTTP Server]
        Client[Dashboard / Developer Client]
    end

    RPC -->|getEvents / getTransaction| Poller
    Poller --> Decoder
    Decoder --> GapDetector
    GapDetector -->|Atomically Write Batch & Cursor| DB

    Decoder -->|Dispatch Decoded Events| Engine
    Engine --> Rule_Stateless
    Engine --> Rule_Windowed
    Rule_Windowed -.->|Query Recent Window| DB

    Engine -->|Trigger Alert| Queue
    Queue --> Dispatcher
    Dispatcher --> Discord
    Dispatcher --> Telegram
    Dispatcher --> Webhook

    Client <-->|REST API\nCRUD Rules, Channels, Contracts| API
    API <--> DB
```

---

## 3. Subsystem Breakdown

### A. Ingestion Engine (`src/ingest/`)
- **Ledger & Cursor Tracking**: Reads the last processed cursor from `ingestion_state`. When requesting `getEvents`, uses the cursor to guarantee strictly forward-moving ingestion without duplication.
- **Retention & Gap Detection**: Soroban RPC nodes retain ledger events for a bounded period (standard default is 24 hours to 7 days). If the watchdog was offline longer than the oldest ledger available on the node, it detects the gap, emits a system alert, and records the gap boundary.
- **Atomic Persistence**: Ingestion writes decoded events and the new cursor in a single database transaction (`db.$transaction`). If the worker crashes mid-batch, zero events are lost or duplicated.

### B. XDR Event Decoder (`src/decoder/`)
- Soroban events arrive as base64-encoded XDR structures: `topics` (an array of `ScVal`) and `data` (a single `ScVal`).
- The decoder parses:
  - Contract addresses (`ScValType.scvAddress` -> `C...` or `G...`)
  - Symbols / method names (`ScValType.scvSymbol` -> `"deposit"`, `"transfer"`, `"pause"`)
  - Big integer amounts (`ScValType.scvI128` -> native `BigInt` string with token decimals precision)
  - Maps, vectors, and boolean flags
- Guarantees JavaScript integer overflow is prevented by handling values up to `i128` as strings and `BigInt`.

### C. Detection Engine (`src/detectors/`)
Pluggable detector architecture implementing a shared interface:
```typescript
interface DetectorPlugin {
  name: string;
  type: 'STATELESS' | 'WINDOWED';
  evaluate(context: DetectorContext): Promise<DetectionResult | null>;
}
```
1. **Stateless Detectors**: Evaluated instantaneously per event (e.g. `LARGE_VALUE_TRANSFER`, `EMERGENCY_PAUSE_TRIGGERED`, `UNAUTHORIZED_CALLER`).
2. **Windowed Detectors**: Evaluates frequency or volume over time windows (e.g. `RAPID_WITHDRAWAL_DRAIN`, `TRANSACTION_FAILURE_SURGE`).

### D. Queue & Retry Engine (`src/queue/`)
- Powered by **BullMQ** on **Redis**.
- **Deterministic Job IDs**: Alert job ID is generated as `alert_${alertId}`, guaranteeing that even if a rule fires twice in a race condition, BullMQ rejects duplicate queue entries.
- **Retry Strategy**: 5 retries with exponential backoff (`delay: 1000 * 2^attempt`) and jitter to prevent hammering downstream webhooks.

### E. Notifier Subsystem (`src/notifiers/`)
Pluggable notifier interface:
```typescript
interface NotifierPlugin {
  channelType: 'DISCORD' | 'TELEGRAM' | 'WEBHOOK';
  send(payload: AlertPayload, config: ChannelConfig): Promise<DeliveryResult>;
}
```
- **Discord**: Embed messages with color-coded severity (🟢 Low, 🟡 Medium, 🔴 Critical) and direct links to StellarExpert.
- **Telegram**: MarkdownV2 formatted telegram messages with contract address tags.
- **Custom Webhook**: Raw JSON payloads signed with an `X-Watchdog-Signature: sha256=...` HMAC header.
- **SSRF Protection**: Webhook URLs are pre-validated to reject loopback (`127.0.0.1`), private RFC1918 subnets (`10.x.x.x`, `192.168.x.x`), and non-HTTPS protocols.

### F. REST API Service (`src/server/`)
- Built on **Fastify** with **Zod** schema validation.
- Endpoints for contract registration, rule definitions, notification channel configurations, and historical telemetry queries.
- Read-only decoupling: The API only queries PostgreSQL; it never directly queries RPC nodes, ensuring high throughput and sub-millisecond responses.

---

## 4. Failure Modes & Resilience Engineering

| Failure Scenario | Threat / Risk | Watchdog Countermeasure |
| :--- | :--- | :--- |
| **RPC Downtime / 429 Rate Limit** | Worker fails to fetch events | Exponential backoff poller with retry loop; resumes from cursor upon recovery. |
| **Worker Process Crash** | Missed events or duplicate reprocessing | Database transaction binds cursor update with event rows atomically; idempotent inserts (`ON CONFLICT (id) DO NOTHING`). |
| **Notification Channel Outage (Discord 500)** | Lost exploit notification | BullMQ job retries with backoff up to 5 times; marks alert as `FAILED` with error log if retries exhaust. |
| **SSRF Webhook Attack** | Attacker configures webhook to scan internal network | Outgoing HTTP requests resolve DNS and block private IP address ranges (`127.0.0.0/8`, `10.0.0.0/8`, etc.). |
| **Database Connection Drop** | Ingestion worker buffer overflow | Worker halts ingestion loop, back-pressures, and reconnects before reading next ledger batch. |
