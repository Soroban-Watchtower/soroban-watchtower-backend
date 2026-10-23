# 🎯 Detector Plugin Engine (`src/detectors/`)

## Architecture & Responsibilities
- The core analytical engine of Soroban Watchdog.
- Evaluates real-time decoded events against configured contract rules to identify anomalies, exploits, and threshold breaches.
- Built on a **Plugin Architecture**: Each rule type is an isolated module implementing the standard `DetectorPlugin` interface.

## Pluggable Interface
```typescript
export interface DetectorPlugin {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly type: 'STATELESS' | 'WINDOWED';
  evaluate(context: DetectorContext): Promise<DetectionResult | null>;
}
```

## Detector Categories
1. **Stateless Detectors**:
   - Evaluate single events in isolation without querying historical data.
   - Examples:
     - `LargeTransferDetector`: Triggers if `amount > rule.threshold`.
     - `EmergencyPauseDetector`: Triggers if topic matches `"pause"` or `"emergency_pause"`.
     - `BlacklistInteractionDetector`: Triggers if an event involves a sanctioned or blacklisted address.
2. **Windowed / Stateful Detectors**:
   - Evaluate time-series patterns over a rolling window (e.g. 5 minutes, 1 hour).
   - Examples:
     - `RapidDrainDetector`: Triggers if aggregate withdrawal volume exceeds X% of baseline within Y minutes.
     - `BurstCallDetector`: Triggers if invocation frequency spikes by > 500% compared to hourly average.
     - `TransactionFailureSurgeDetector`: Triggers if multiple reverts occur within a short burst.

## Drips Wave Contributor Opportunity
Because each detector is a single, isolated file with an exact TypeScript interface and unit test suite, external contributors can easily build and submit new detectors as self-contained Drips Wave issues.
