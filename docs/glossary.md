# 📖 Soroban Watchdog Domain Glossary

Precise definitions for core concepts across Stellar, Soroban, smart contract telemetry, and distributed systems architecture.

---

### Core Blockchain Terms
- **Soroban**: The Rust-based native smart contract platform built directly on the Stellar blockchain.
- **ScVal**: Soroban Contract Value. The binary XDR specification defining typed data structures (e.g., `scvU32`, `scvI128`, `scvAddress`, `scvSymbol`, `scvMap`).
- **Ledger Sequence**: Monotonically increasing 32-bit integer identifying each closed block on the Stellar network (typically closing every ~5 seconds).
- **Ingestion Cursor**: Lexicographically orderable string identifier (`{ledger}-{txIndex}-{eventIndex}`) marking the exact boundary of events processed by the watchdog.

### Watchdog Architecture
- **Dual-Engine Architecture**: A unified single-process runtime hosting both an active state-synchronizing ingestion poller and a decoupled Fastify read API.
- **Zero-Chain-Roundtrip Read**: An architectural principle where API queries are resolved entirely from local PostgreSQL mirror data and in-memory domain math without querying blockchain RPC nodes.
- **Poller Lag**: The delta between the latest ledger sequence closed on the blockchain (`chainLedger`) and the highest ledger processed locally (`lastLedgerSequence`).
- **Dead-Letter Quarantine (`FailedEvent`)**: A dedicated relational table storing corrupted or unparseable raw events alongside stack traces, ensuring the poller never crashes on malformed inputs.

### Detection & Alerting
- **Detector Plugin**: A self-contained evaluator implementing `DetectorPlugin` that analyzes Soroban events and returns a `DetectionResult`.
- **Stateless Detector**: An instantaneous rule evaluated on single events without historical state queries (e.g., `LARGE_VALUE_TRANSFER`, `EMERGENCY_PAUSE`).
- **Windowed Detector**: A stateful rule that aggregates volume or frequency over rolling time windows (e.g., `RAPID_WITHDRAWAL_DRAIN`, `FAILED_TX_BURST`).
- **HMAC Webhook Signature**: Cryptographic proof attached to outgoing webhooks as `X-Watchdog-Signature: sha256=...` generated via `crypto.createHmac('sha256', secret)` to verify authenticity.
- **SSRF (Server-Side Request Forgery)**: A vulnerability where an attacker tricks a server into making HTTP calls to internal resources. Mitigated via strict DNS checks and private subnet blocking.
