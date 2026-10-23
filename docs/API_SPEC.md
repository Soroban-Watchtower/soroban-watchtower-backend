# 🌐 REST API Specification

Soroban Watchdog exposes a clean, typed REST API for protocol dashboards, automated CI/CD pipelines, and alerting configuration.

---

## 1. Design Principles
- **Base URL**: `/api/v1`
- **Content-Type**: `application/json`
- **Validation**: Strict schema validation using **Zod**.
- **Address Formatting**: All contract addresses are strictly validated against Soroban StrKey format (`^C[A-Z0-9]{55}$`).
- **Standardized Error Format**:
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid Soroban contract address format",
    "details": []
  }
}
```

---

## 2. API Endpoints

### A. Health & Diagnostics
#### `GET /api/v1/health`
Checks PostgreSQL, Redis, and Stellar RPC connectivity.
- **Response `200 OK`**:
```json
{
  "status": "healthy",
  "version": "1.0.0",
  "services": {
    "database": "connected",
    "redis": "connected",
    "rpc": "synced"
  },
  "currentLedger": 1234567
}
```

---

### B. Contracts Management
#### `POST /api/v1/contracts`
Register a Soroban contract for active monitoring.
- **Request Body**:
```json
{
  "address": "CA3D52W2QB2UP0KZK2GZAKOWU5CEOG4O35HS7RGSJZW2VQH3VAQ7F4",
  "name": "DeFi Liquidity Vault",
  "network": "TESTNET"
}
```
- **Response `201 Created`**:
```json
{
  "success": true,
  "data": {
    "id": "CA3D52W2QB2UP0KZK2GZAKOWU5CEOG4O35HS7RGSJZW2VQH3VAQ7F4",
    "name": "DeFi Liquidity Vault",
    "network": "TESTNET",
    "active": true,
    "createdAt": "2026-10-22T14:30:00Z"
  }
}
```

#### `GET /api/v1/contracts`
List all monitored contracts with active rule counts and ingestion status.

#### `GET /api/v1/contracts/:id`
Fetch contract metadata, current cursor, and telemetry summary.

---

### C. Rules Management
#### `POST /api/v1/rules`
Create an alerting rule for a registered contract.
- **Request Body**:
```json
{
  "contractId": "CA3D52W2QB2UP0KZK2GZAKOWU5CEOG4O35HS7RGSJZW2VQH3VAQ7F4",
  "name": "Large Withdrawal Alert",
  "detectorType": "LARGE_VALUE_TRANSFER",
  "severity": "HIGH",
  "parameters": {
    "symbol": "withdraw",
    "threshold": "50000000000",
    "decimals": 7
  },
  "channelIds": ["b2c3d4e5-6789-abcd-ef01-234567890abc"]
}
```
- **Response `201 Created`**

#### `GET /api/v1/rules?contractId=...`
List rules defined for a contract.

---

### D. Channels Management (Notification Destinations)
#### `POST /api/v1/channels`
Register an alerting channel (Discord, Telegram, Webhook).
- **Request Body (Discord Example)**:
```json
{
  "name": "Security War Room Discord",
  "type": "DISCORD",
  "destination": "https://discord.com/api/webhooks/123456789/abcdef..."
}
```
- **Request Body (Custom Webhook Example with HMAC)**:
```json
{
  "name": "Protocol Incident Response Service",
  "type": "WEBHOOK",
  "destination": "https://api.myprotocol.fi/webhooks/security",
  "secret": "super_secret_hmac_key"
}
```
- **Response `201 Created`**

---

### E. Events & Alerts Telemetry (Dashboard Feeds)
#### `GET /api/v1/events?contractId=...&limit=50&cursor=...`
Paginated feed of decoded contract events.

#### `GET /api/v1/alerts?contractId=...&severity=HIGH`
List triggered security alerts with delivery status.
