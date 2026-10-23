# 💾 Persistence Layer & Repositories (`src/db/`)

## Architecture & Responsibilities
- Houses the database client instance, schema queries, and domain repositories.
- Built on **Prisma ORM** with **PostgreSQL**.

## Directory Layout
- `client.ts`: Singleton instance of `PrismaClient` with connection pooling and logging hooks.
- `encryption.ts`: AES-256-GCM encryption and decryption utilities for sensitive credentials.
- `repositories/`:
  - `contractRepository.ts`: CRUD operations for registered contracts.
  - `eventRepository.ts`: Batch insertion of events and cursor persistence.
  - `ruleRepository.ts`: Rule management and retrieval.
  - `alertRepository.ts`: Alert creation and delivery status tracking.

## Concurrency & Idempotency Rules
- Event persistence uses `createMany` with `skipDuplicates: true`.
- Ingestion state updates and event batch insertions run in a single atomic `$transaction`.
