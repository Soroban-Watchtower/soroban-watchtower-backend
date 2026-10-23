# 🧪 Test Architecture & Suite Guidelines (`tests/`)

## Testing Philosophy
Soroban Watchdog is developer and security infrastructure. Code quality, regression prevention, and edge-case testing are paramount for Drips Wave repository acceptance.

## Test Structure
```
tests/
├── unit/             # Fast, zero-dependency unit tests
│   ├── decoder.test.ts      # XDR binary to ScVal and BigInt parsing
│   ├── detectors.test.ts    # Rule evaluation logic, thresholds, boundaries
│   └── ssrf.test.ts         # SSRF URL validator and IP resolver
├── integration/      # Real database and Redis integration tests
│   ├── api.test.ts          # Fastify route endpoints and response shapes
│   ├── ingestion.test.ts    # Poller loop and atomic cursor updates
│   └── queue.test.ts        # BullMQ job dispatch and backoff retry logic
└── mocks/            # Fixtures & recorded Soroban RPC payloads
    ├── rpcEvents.json       # Real Testnet getEvents fixture data
    └── contracts.ts         # Mock Soroban contract addresses
```

## Running Tests
- `npm run test`: Runs the Vitest test runner.
- `npm run test:coverage`: Asserts minimum 80% branch and statement coverage.
