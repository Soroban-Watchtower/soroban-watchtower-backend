# 🛑 Ordered Graceful Shutdown Architecture

This document details the deterministic, prioritized shutdown sequence orchestrated by **GracefulShutdownManager** (`src/observability/shutdown.ts`) when receiving termination signals (`SIGINT` or `SIGTERM`).

---

## 1. Shutdown Sequence Diagram

```mermaid
sequenceDiagram
    autonumber
    actor OS as Operating System / K8s
    participant SM as GracefulShutdownManager
    participant Poller as Ingestion Poller
    participant Worker as BullMQ Alert Worker
    participant Fastify as Fastify HTTP Server
    participant DB as Prisma PostgreSQL Pool
    participant Process as Node.js Process

    OS->>SM: Emit SIGTERM or SIGINT
    Note over SM: Start 15s Safety Watchdog Timer
    
    SM->>Poller: Step 10: Halt Ingestion Loop
    Note over Poller: Stop requesting new ledger batches from RPC
    Poller-->>SM: Poller Halted

    SM->>Worker: Step 20: Drain BullMQ Worker
    Note over Worker: Finish in-flight webhook posts; stop pulling jobs
    Worker-->>SM: Worker Closed

    SM->>Fastify: Step 30: Close HTTP Listener
    Note over Fastify: Stop accepting new TCP connections; finish in-flight responses
    Fastify-->>SM: HTTP Listener Closed

    SM->>DB: Step 90: Drain Prisma Connection Pool
    Note over DB: Flush pending writes; terminate client pool connections
    DB-->>SM: Pool Drained

    Note over SM: Cancel Watchdog Timer
    SM->>Process: Exit with Code 0
```

---

## 2. Step-by-Step Rationale

### Step 1 (Priority 10): Halt Ingestion Poller
- **Why First**: Halts ingestion before closing dependent subsystems. Prevents new events from attempting database writes or detector evaluations while the system is winding down.

### Step 2 (Priority 20): Drain Alert Queue & Worker
- **Why Second**: Allows active HTTP webhook posts and Discord requests to complete their current attempt. Prevents truncated or corrupted outbound socket connections.

### Step 3 (Priority 30): Close Fastify HTTP Server
- **Why Third**: Stops accepting new external requests at the port listener while allowing currently executing read queries to return cleanly to clients.

### Step 4 (Priority 90): Drain Database Connection Pool (`prisma.$disconnect()`)
- **Why Last**: Must execute after all upstream worker and server queries have completed, ensuring zero `ConnectionPoolClosedError` exceptions are thrown during shutdown.
