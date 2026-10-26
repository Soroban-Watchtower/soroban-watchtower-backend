# 📚 Soroban Watchdog Documentation Index

Welcome to the engineering and operational documentation for **Soroban Watchdog**, the telemetry, anomaly surveillance, and exploit-alerting engine for Stellar Soroban smart contracts.

---

## 🧭 Navigation & Guides

| Document | Purpose & Core Topics |
| :--- | :--- |
| **[Architecture & Core System](ARCHITECTURE.md)** | Subsystem breakdowns, dual-engine topology, plugin interfaces, and resiliency models. |
| **[Database Schema Reference](database-schema.md)** | Field-by-field PostgreSQL schema, precision types, composite indexes, and AES-256-GCM encryption. |
| **[Request Lifecycle](request-lifecycle.md)** | Step-by-step walkthrough of incoming HTTP request handling, correlation IDs, and zero-chain-roundtrip queries. |
| **[Poll-Tick Sequence](poll-tick-sequence.md)** | Sequence diagram, cursor tracking, atomic database transactions, and backlog fast-forwarding. |
| **[Failure Modes & Runbooks](failure-modes.md)** | Comprehensive disaster recovery matrix, circuit breakers, dead-letter quarantine, and runbooks. |
| **[Shutdown Ordering](shutdown-ordering.md)** | In-depth breakdown of the ordered 6-step graceful termination sequence. |
| **[Domain Glossary](glossary.md)** | Precise terminology definitions for Stellar, Soroban XDR, telemetry, and security concepts. |
| **[API Specification](API_SPEC.md)** | Complete REST API endpoint reference and JSON payload contracts. |
| **[Data Pipeline Guide](DATA_PIPELINE.md)** | End-to-end event flow from Stellar ledger to Discord and HMAC webhooks. |
| **[Drips Wave Roadmap](DRIPS_WAVE_ROADMAP.md)** | Contributor task matrix, issue breakdown, and maintainer review standards. |
