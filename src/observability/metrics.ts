/**
 * High-performance, zero-dependency Prometheus metrics registry for Soroban Watchdog.
 * Formats metrics strictly according to the Prometheus text exposition specification.
 */

export type MetricType = 'counter' | 'gauge' | 'histogram';

export interface MetricOptions {
  name: string;
  help: string;
  labelNames?: string[];
}

export interface HistogramOptions extends MetricOptions {
  buckets?: number[];
}

function formatLabels(labels?: Record<string, string | number>): string {
  if (!labels || Object.keys(labels).length === 0) {
    return '';
  }
  const pairs = Object.entries(labels)
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`)
    .join(',');
  return `{${pairs}}`;
}

export class Counter {
  readonly name: string;
  readonly help: string;
  readonly labelNames: string[];
  private readonly values = new Map<string, number>();

  constructor(options: MetricOptions) {
    this.name = options.name;
    this.help = options.help;
    this.labelNames = options.labelNames || [];
  }

  inc(labels?: Record<string, string | number>, value: number = 1): void {
    if (value < 0) {
      throw new Error('Counter can only be incremented with non-negative values');
    }
    const key = formatLabels(labels);
    const current = this.values.get(key) || 0;
    this.values.set(key, current + value);
  }

  get(labels?: Record<string, string | number>): number {
    return this.values.get(formatLabels(labels)) || 0;
  }

  reset(): void {
    this.values.clear();
  }

  render(): string {
    if (this.values.size === 0) {
      return `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} counter\n${this.name} 0\n`;
    }
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
    ];
    for (const [key, val] of this.values.entries()) {
      lines.push(`${this.name}${key} ${val}`);
    }
    return lines.join('\n') + '\n';
  }
}

export class Gauge {
  readonly name: string;
  readonly help: string;
  readonly labelNames: string[];
  private readonly values = new Map<string, number>();

  constructor(options: MetricOptions) {
    this.name = options.name;
    this.help = options.help;
    this.labelNames = options.labelNames || [];
  }

  set(value: number, labels?: Record<string, string | number>): void {
    this.values.set(formatLabels(labels), value);
  }

  inc(labels?: Record<string, string | number>, value: number = 1): void {
    const key = formatLabels(labels);
    const current = this.values.get(key) || 0;
    this.values.set(key, current + value);
  }

  dec(labels?: Record<string, string | number>, value: number = 1): void {
    const key = formatLabels(labels);
    const current = this.values.get(key) || 0;
    this.values.set(key, current - value);
  }

  get(labels?: Record<string, string | number>): number {
    return this.values.get(formatLabels(labels)) || 0;
  }

  reset(): void {
    this.values.clear();
  }

  render(): string {
    if (this.values.size === 0) {
      return `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} gauge\n${this.name} 0\n`;
    }
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
    ];
    for (const [key, val] of this.values.entries()) {
      lines.push(`${this.name}${key} ${val}`);
    }
    return lines.join('\n') + '\n';
  }
}

export class Histogram {
  readonly name: string;
  readonly help: string;
  readonly buckets: number[];
  private readonly entries = new Map<
    string,
    { count: number; sum: number; bucketCounts: number[] }
  >();

  constructor(options: HistogramOptions) {
    this.name = options.name;
    this.help = options.help;
    this.buckets = options.buckets || [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
    this.buckets.sort((a, b) => a - b);
  }

  observe(value: number, labels?: Record<string, string | number>): void {
    const key = formatLabels(labels);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { count: 0, sum: 0, bucketCounts: new Array(this.buckets.length).fill(0) };
      this.entries.set(key, entry);
    }

    entry.count += 1;
    entry.sum += value;

    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) {
        entry.bucketCounts[i] += 1;
      }
    }
  }

  reset(): void {
    this.entries.clear();
  }

  render(): string {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];

    for (const [key, entry] of this.entries.entries()) {
      const baseLabelStr = key.length > 2 ? key.slice(1, -1) + ',' : '';

      for (let i = 0; i < this.buckets.length; i++) {
        lines.push(
          `${this.name}_bucket{${baseLabelStr}le="${this.buckets[i]}"} ${entry.bucketCounts[i]}`
        );
      }
      lines.push(`${this.name}_bucket{${baseLabelStr}le="+Inf"} ${entry.count}`);
      lines.push(`${this.name}_sum${key} ${entry.sum}`);
      lines.push(`${this.name}_count${key} ${entry.count}`);
    }

    return lines.join('\n') + '\n';
  }
}

export class MetricsRegistry {
  private readonly counters = new Map<string, Counter>();
  private readonly gauges = new Map<string, Gauge>();
  private readonly histograms = new Map<string, Histogram>();

  registerCounter(options: MetricOptions): Counter {
    if (this.counters.has(options.name)) {
      return this.counters.get(options.name)!;
    }
    const counter = new Counter(options);
    this.counters.set(options.name, counter);
    return counter;
  }

  registerGauge(options: MetricOptions): Gauge {
    if (this.gauges.has(options.name)) {
      return this.gauges.get(options.name)!;
    }
    const gauge = new Gauge(options);
    this.gauges.set(options.name, gauge);
    return gauge;
  }

  registerHistogram(options: HistogramOptions): Histogram {
    if (this.histograms.has(options.name)) {
      return this.histograms.get(options.name)!;
    }
    const histogram = new Histogram(options);
    this.histograms.set(options.name, histogram);
    return histogram;
  }

  exportMetrics(): string {
    let output = '';
    for (const gauge of this.gauges.values()) {
      output += gauge.render() + '\n';
    }
    for (const counter of this.counters.values()) {
      output += counter.render() + '\n';
    }
    for (const hist of this.histograms.values()) {
      output += hist.render() + '\n';
    }
    return output.trimEnd() + '\n';
  }

  reset(): void {
    for (const c of this.counters.values()) c.reset();
    for (const g of this.gauges.values()) g.reset();
    for (const h of this.histograms.values()) h.reset();
  }
}

// Global registry singleton
export const metrics = new MetricsRegistry();

// -------------------------------------------------------------
// Standard Observability Metric Definitions
// -------------------------------------------------------------

// Poller Lag & Height Metrics
export const pollerLagLedgers = metrics.registerGauge({
  name: 'soroban_poller_lag_ledgers',
  help: 'Real-time ledger lag calculated as chainLedger minus lastLedgerSequence',
  labelNames: ['contract_id'],
});

export const pollerChainLedger = metrics.registerGauge({
  name: 'soroban_poller_chain_ledger',
  help: 'Current Soroban blockchain head ledger sequence reported by RPC',
  labelNames: ['network'],
});

export const pollerLastLedger = metrics.registerGauge({
  name: 'soroban_poller_last_ledger',
  help: 'Last ledger sequence fully processed and persisted for contract',
  labelNames: ['contract_id'],
});

// Poller Operation Counters & Histograms
export const pollerTicksTotal = metrics.registerCounter({
  name: 'soroban_poller_ticks_total',
  help: 'Total count of poller tick executions categorized by status (success, error, empty)',
  labelNames: ['status'],
});

export const pollerTickDuration = metrics.registerHistogram({
  name: 'soroban_poller_tick_duration_seconds',
  help: 'Duration of poller ingestion tick in seconds',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
});

// Event Metrics
export const eventsIngestedTotal = metrics.registerCounter({
  name: 'soroban_events_ingested_total',
  help: 'Total decoded Soroban contract events ingested',
  labelNames: ['contract_id', 'event_type'],
});

export const failedEventsTotal = metrics.registerCounter({
  name: 'soroban_failed_events_total',
  help: 'Total unparseable or rejected events quarantined in dead-letter table',
  labelNames: ['contract_id', 'reason'],
});

// Alerts & Notifier Metrics
export const alertsTriggeredTotal = metrics.registerCounter({
  name: 'soroban_alerts_triggered_total',
  help: 'Total security and anomaly alerts generated by detector runner',
  labelNames: ['rule_id', 'severity'],
});

export const alertDeliveriesTotal = metrics.registerCounter({
  name: 'soroban_alert_deliveries_total',
  help: 'Total alert notifications delivered to external channels',
  labelNames: ['channel_type', 'status'],
});

// HTTP API Server Metrics
export const httpRequestsTotal = metrics.registerCounter({
  name: 'soroban_http_requests_total',
  help: 'Total incoming HTTP requests handled by REST API',
  labelNames: ['method', 'route', 'status_code'],
});

export const httpRequestDuration = metrics.registerHistogram({
  name: 'soroban_http_request_duration_seconds',
  help: 'Duration of HTTP requests handled by REST API in seconds',
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});
