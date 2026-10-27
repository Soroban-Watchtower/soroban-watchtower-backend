# 🚀 REST API Server (`src/server/`)

## Architecture & Responsibilities
- Built on **Fastify** for maximum performance and low latency.
- Handles incoming HTTP requests for:
  - Registering and managing Soroban contracts (`POST /api/v1/contracts`).
  - Creating and toggling detector rules (`POST /api/v1/rules`).
  - Adding notification destinations (`POST /api/v1/channels`).
  - Serving historical telemetry events (`GET /api/v1/events`).
  - Serving triggered security alerts (`GET /api/v1/alerts`).
  - Serving zero-chain-roundtrip contract telemetry summaries (`GET /api/v1/telemetry/:contractId`).
  - Health, liveness, and readiness probes (`/healthz`, `/livez`, `/readyz`).
  - Prometheus metrics export (`/metrics`) and OpenAPI documentation (`/docs`).
- **Zero-Chain-Roundtrip**: The REST API queries the local PostgreSQL mirror. It never makes synchronous calls to external Soroban RPC nodes or notification targets, guaranteeing consistent sub-millisecond response times.
- **Input Validation**: Strict Zod schema validation on request bodies and query parameters returning RFC 7807 Problem Details.
- **Route Decoupling**: Modular plugins organized under `src/server/routes/`.

---

## Interactive OpenAPI Documentation
Open in browser:
```
http://localhost:4000/docs
```

---

## API Endpoints & Curl Verification Examples

### 1. Register a Contract Address
```bash
curl -X POST http://localhost:4000/api/v1/contracts \
  -H "Content-Type: application/json" \
  -d '{
    "id": "CA3D5KRYMCMUZGTAQAWXXAZ264BVVCXCHHQETBRVFRKZXXOIS4K5P35B",
    "name": "DeFi Liquidity Pool",
    "network": "TESTNET",
    "active": true
  }'
```

### 2. Add a Notification Channel (Discord / Webhook)
```bash
# Discord Webhook (destination encrypted in database at rest via AES-256-GCM)
curl -X POST http://localhost:4000/api/v1/channels \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Security Ops Discord",
    "type": "DISCORD",
    "destination": "https://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz"
  }'

# Generic Webhook with HMAC signing secret
curl -X POST http://localhost:4000/api/v1/channels \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Ops Incident Webhook",
    "type": "WEBHOOK",
    "destination": "https://ops.example.com/api/watchtower/hook",
    "secret": "my-shared-hmac-secret-key"
  }'
```

### 3. Create an Alert Rule for a Contract
```bash
curl -X POST http://localhost:4000/api/v1/rules \
  -H "Content-Type: application/json" \
  -d '{
    "contractId": "CA3D5KRYMCMUZGTAQAWXXAZ264BVVCXCHHQETBRVFRKZXXOIS4K5P35B",
    "name": "Detect Large Value Transfer",
    "detectorType": "LARGE_VALUE_TRANSFER",
    "severity": "CRITICAL",
    "parameters": {
      "threshold": "10000000000",
      "token": "USDC"
    },
    "enabled": true
  }'
```

### 4. Read Historical Telemetry Events
```bash
# Query historical telemetry events with pagination and filters
curl -X GET "http://localhost:4000/api/v1/events?contractId=CA3D5KRYMCMUZGTAQAWXXAZ264BVVCXCHHQETBRVFRKZXXOIS4K5P35B&limit=20&offset=0"

# Query single event by ID
curl -X GET "http://localhost:4000/api/v1/events/005000-0001-0000"
```

### 5. Read Historical Security Alerts
```bash
# Query alerts with severity and pagination filters
curl -X GET "http://localhost:4000/api/v1/alerts?severity=CRITICAL&limit=20&offset=0"

# Query single alert by ID
curl -X GET "http://localhost:4000/api/v1/alerts/alert-uuid-1"
```

### 6. Health & Diagnostics
```bash
curl -X GET http://localhost:4000/healthz
curl -X GET http://localhost:4000/livez
curl -X GET http://localhost:4000/readyz
curl -X GET http://localhost:4000/metrics
```
