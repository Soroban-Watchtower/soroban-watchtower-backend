# 🌊 Drips Wave Maintainer Strategy & Issue Breakdown

This document outlines the operational plan to ensure **Soroban Watchdog** meets every requirement of the **Drips Wave** program for repository approval, maintainer status, and community contributions.

---

## 1. Drips Wave Compliance Checklist

To prevent repository rejection:
- [x] **Clear Value Proposition**: Addresses an explicit developer tooling & security gap in the Soroban/Stellar ecosystem.
- [x] **Monorepo / Clean Architecture**: Production-grade TypeScript, clear separation of concerns, and modular pluggability.
- [x] **Modular Extensibility**: Pluggable detector and notifier interfaces allow external contributors to ship self-contained features.
- [x] **No LLM Slop**: High-quality architecture, strict type definitions, full error handling, unit/integration test scaffolds, and clear documentation.
- [x] **Security-First**: Outgoing webhook SSRF protection, secret encryption at rest, and strict Zod input validation.
- [x] **Zero-Hassle Local Setup**: Single-command startup via `docker-compose` and `.env.example`.

---

## 2. Drips Wave Contributor Issues Catalog

Drips Wave assigns tasks into three complexity tiers:
- **Trivial (100 Points)**: Well-scoped, isolated additions (new detectors, new notifiers, formatting helpers, test suites).
- **Medium (150 Points)**: Core subsystem enhancements, caching layers, window aggregation queries, or CLI commands.
- **High (200 Points)**: Complex blockchain integrations, state verification, or multi-contract correlation engines.

### Tier 1: Trivial Complexity (100 Points Each)
1. **Issue #1**: `feat(notifiers)`: Implement Slack incoming webhook notification plugin.
   - *Scope*: Implement `NotifierPlugin` interface to post formatted Slack block-kit messages when alerts trigger.
2. **Issue #2**: `feat(detectors)`: Add `EmergencyPauseDetector` for Soroban contracts.
   - *Scope*: Stateless detector that checks topic symbols for `"pause"`, `"emergency_stop"`, or `"freeze"` and triggers `CRITICAL` alert.
3. **Issue #3**: `feat(decoder)`: Add SAC (Stellar Asset Contract) standard event parser.
   - *Scope*: Add dedicated parsing for standard SEP-41 token events (`transfer`, `mint`, `clawback`, `burn`).
4. **Issue #4**: `test(detectors)`: Add comprehensive unit test matrix for `LargeTransferDetector`.
   - *Scope*: Test boundary conditions: precision limits, decimals scaling, negative amounts, zero amount.

---

### Tier 2: Medium Complexity (150 Points Each)
5. **Issue #5**: `feat(detectors)`: Implement `RapidDrainDetector` (Windowed Rule).
   - *Scope*: Track cumulative withdrawal volume over rolling 5-minute window; trigger alert if outflow exceeds 25% of 24h baseline.
6. **Issue #6**: `feat(security)`: Add SSRF DNS validation for custom webhook endpoints.
   - *Scope*: Intercept webhook requests, perform asynchronous DNS lookup, and block private CIDR blocks (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`).
7. **Issue #7**: `feat(queue)`: Implement per-channel rate-limiting in BullMQ.
   - *Scope*: Prevent flooding Discord/Telegram APIs during high-volume exploit events using BullMQ's rate-limiter tokens.
8. **Issue #8**: `feat(ingest)`: Add transaction failure ingestion via `getTransaction`.
   - *Scope*: Ingest failed contract calls (`txStatus == FAILED`) to track exploit attempts that revert.
9. **Issue #9**: `feat(api)`: Add API key authentication & rate limiting for REST endpoints.
   - *Scope*: Add fastify bearer token auth and sliding window rate limiter.

---

### Tier 3: High Complexity (200 Points Each)
10. **Issue #10**: `feat(ingest)`: Multi-Contract Ingestion Batching & Worker Sharding.
    - *Scope*: Group contract filters into batches of 5 (Soroban RPC limit) and dynamically shard worker instances across multiple contract sets.
11. **Issue #11**: `feat(analysis)`: Cross-Contract Flash-Loan & Liquidity Drain Correlation Engine.
    - *Scope*: Correlate simultaneous events across multiple contracts inside the same ledger sequence to detect multi-protocol exploit sequences.
12. **Issue #12**: `feat(state)`: Soroban Ledger Key State Verifier.
    - *Scope*: Use RPC `getLedgerEntries` to inspect and verify contract storage foot-print changes alongside emitted events.

---

## 3. Pull Request & Review Standards for Maintainers

As a Drips Wave maintainer, you must maintain review rigor:
1. **Automated Checks**: Every PR must pass CI (`npm run lint`, `npm run test`, `npm run build`).
2. **Deterministic Code**: Reject any PR introducing floating-point token arithmetic or unhandled promise rejections.
3. **Test Coverage**: Every new detector or notifier must include dedicated unit tests with mock payloads.
4. **Fast Turnaround**: Maintainers are expected to review PRs within 24–48 hours during active Wave sprints.
