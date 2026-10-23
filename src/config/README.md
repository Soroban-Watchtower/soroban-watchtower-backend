# ⚙️ Configuration Subsystem (`src/config/`)

## Responsibilities
- Centralizes application settings and environment variables.
- Uses **Zod** to validate environment variables at startup (`env.ts`).
- Fails fast with descriptive errors if any mandatory environment variable (`DATABASE_URL`, `REDIS_URL`, `SOROBAN_RPC_URL`, `ENCRYPTION_KEY`) is missing or malformed.

## Key Environment Variables
- `NODE_ENV`: `development` | `production` | `test`
- `PORT`: HTTP API port (default: 4000)
- `DATABASE_URL`: PostgreSQL connection string (`postgresql://postgres:postgres@localhost:5432/soroban_watchdog`)
- `REDIS_URL`: Redis connection string (`redis://localhost:6379`)
- `SOROBAN_RPC_URL`: Soroban RPC endpoint (e.g., `https://soroban-testnet.stellar.org`)
- `ENCRYPTION_KEY`: 32-byte hexadecimal string for AES-256-GCM encryption of webhook secrets and bot tokens
- `POLL_INTERVAL_MS`: Polling interval for Soroban RPC (default: 5000ms)
- `LOG_LEVEL`: `debug` | `info` | `warn` | `error`
