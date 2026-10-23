# 🚀 REST API Server (`src/server/`)

## Architecture & Responsibilities
- Built on **Fastify** for maximum performance and low latency.
- Handles incoming HTTP requests for:
  - Registering and managing Soroban contracts.
  - Creating and toggling detector rules.
  - Adding notification destinations (Discord, Telegram, Webhook).
  - Serving historical telemetry and triggered security alerts.
- **Pure Database Queries**: The REST API queries PostgreSQL only. It never makes synchronous calls to external Soroban RPC nodes or notification targets, guaranteeing consistent sub-millisecond response times.
- **Input Validation**: Every incoming request payload and query parameter is validated against Zod schemas.

## Directory Structure
- `routes/`: Route controllers (`contracts.ts`, `rules.ts`, `channels.ts`, `alerts.ts`, `health.ts`).
- `schemas/`: Zod validation schemas and DTOs.
- `plugins/`: Fastify plugins (CORS, Swagger/OpenAPI, error handling, rate limiting).
- `index.ts`: Fastify server initialization and lifecycle hooks.
