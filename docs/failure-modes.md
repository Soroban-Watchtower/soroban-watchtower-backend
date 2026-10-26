# 🛡️ Failure Modes, Circuit Breakers & Runbooks

This guide outlines potential operational failures, automated watchdog countermeasures, and runbooks for production incident response.

---

## 1. Failure Modes Matrix

| Failure Mode | Root Cause | Impact | Automated Countermeasure | Runbook Reference |
| :--- | :--- | :--- | :--- | :--- |
| **RPC 429 Rate Limiting** | Soroban RPC rate limits exceeded | Poller loop blocked | Exponential backoff retry with jitter up to 5 attempts | [Runbook 1: RPC Rate Limiting](#runbook-1-rpc-rate-limiting) |
| **Quiet Chain vs. Stalled Poller** | No transactions occurring on-chain | High apparent lag or static cursor | Poller advances `chainLedger` on empty ticks to maintain lag accuracy | [Runbook 2: Diagnosing Poller Lag](#runbook-2-diagnosing-poller-lag) |
| **Malformed XDR Event** | Upstream smart contract emits corrupt XDR | Ingestion could crash | Quarantined in `FailedEvent` dead-letter queue; poller advances safely | [Runbook 3: Replaying Dead-Letter Events](#runbook-3-replaying-dead-letter-events) |
| **Webhook SSRF Attack** | Attacker registers private IP webhook | Potential intranet leak | SSRF validator blocks non-HTTPS and private CIDRs (`127.0.0.1`, `10.0.0.0/8`, AWS metadata) | [Runbook 4: Webhook Security](#runbook-4-webhook-security) |
| **Discord Channel Outage (429/500)** | Discord API degraded | Alert notification undelivered | BullMQ retries up to 5 times with exponential backoff (1s, 2s, 4s, 8s, 16s) | [Runbook 5: Notification Delivery](#runbook-5-notification-delivery) |
| **Database Connection Exhaustion** | Spike in API requests | DB queries fail | Connection pool draining on graceful shutdown; Fastify sliding-window rate limiting | [Runbook 6: Database Pooling](#runbook-6-database-pooling) |

---

## 2. Operational Runbooks

### Runbook 1: RPC Rate Limiting
- **Symptom**: Logs show `SorobanRpcClient HTTP 429 Too Many Requests`.
- **Action**:
  1. Check metric `soroban_poller_ticks_total{status="error"}`.
  2. Increase `POLL_INTERVAL_MS` in `.env` from `5000` to `10000`.
  3. Configure a private RPC node endpoint via `SOROBAN_RPC_URL`.

### Runbook 2: Diagnosing Poller Lag
- **Symptom**: Metric `soroban_poller_lag_ledgers > 50`.
- **Diagnostic**:
  ```bash
  # Check current lag via API
  curl http://localhost:4000/readyz
  ```
- **Action**:
  1. Inspect network connectivity to `SOROBAN_RPC_URL`.
  2. If the watchdog was offline for longer than node retention (typically 24 hours), check for gaps using `cursorManager.checkLedgerGap()`.
  3. Increase `MAX_EVENTS_PER_BATCH` to `200` to accelerate fast-forward catchup.

### Runbook 3: Replaying Dead-Letter Events
- **Symptom**: `FailedEvent` count > 0 in dead-letter table.
- **Action**:
  ```bash
  # Inspect failed events via API
  curl http://localhost:4000/api/v1/failed-events?status=PENDING

  # Replay all pending failed events via CLI
  npm run replay-failed-events

  # Prune resolved failed events older than 14 days
  npm run prune-failed-events -- --days=14
  ```

### Runbook 4: Webhook Security & SSRF
- **Symptom**: Webhook alert delivery returns `SSRF validation blocked request`.
- **Action**:
  1. Inspect destination URL in `AlertDelivery.lastError`.
  2. Confirm destination resolves to a public HTTPS domain.
  3. Loopback (`127.0.0.1`), RFC 1918 subnets, and AWS metadata (`169.254.169.254`) are strictly blocked by design.
