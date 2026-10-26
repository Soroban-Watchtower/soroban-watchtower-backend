import { describe, it, expect, beforeEach } from 'vitest';
import {
  MetricsRegistry,
  Counter,
  Gauge,
  Histogram,
} from '../../src/observability/metrics.js';

describe('Prometheus Observability Metrics Registry (src/observability/metrics)', () => {
  let registry: MetricsRegistry;

  beforeEach(() => {
    registry = new MetricsRegistry();
  });

  it('should increment counters and render Prometheus text exposition format', () => {
    const counter = registry.registerCounter({
      name: 'test_events_total',
      help: 'Total test events ingested',
      labelNames: ['contract_id', 'status'],
    });

    counter.inc({ contract_id: 'C123', status: 'success' }, 5);
    counter.inc({ contract_id: 'C123', status: 'success' }, 2);
    counter.inc({ contract_id: 'C456', status: 'error' }, 1);

    expect(counter.get({ contract_id: 'C123', status: 'success' })).toBe(7);
    expect(counter.get({ contract_id: 'C456', status: 'error' })).toBe(1);

    const rendered = registry.exportMetrics();
    expect(rendered).toContain('# HELP test_events_total Total test events ingested');
    expect(rendered).toContain('# TYPE test_events_total counter');
    expect(rendered).toContain('test_events_total{contract_id="C123",status="success"} 7');
    expect(rendered).toContain('test_events_total{contract_id="C456",status="error"} 1');
  });

  it('should set, inc, and dec gauges and render correctly', () => {
    const gauge = registry.registerGauge({
      name: 'test_poller_lag_ledgers',
      help: 'Real-time poller lag in ledgers',
      labelNames: ['contract_id'],
    });

    gauge.set(10, { contract_id: 'CA3D' });
    expect(gauge.get({ contract_id: 'CA3D' })).toBe(10);

    gauge.dec({ contract_id: 'CA3D' }, 3);
    expect(gauge.get({ contract_id: 'CA3D' })).toBe(7);

    gauge.inc({ contract_id: 'CA3D' }, 2);
    expect(gauge.get({ contract_id: 'CA3D' })).toBe(9);

    const rendered = registry.exportMetrics();
    expect(rendered).toContain('# TYPE test_poller_lag_ledgers gauge');
    expect(rendered).toContain('test_poller_lag_ledgers{contract_id="CA3D"} 9');
  });

  it('should observe histogram values and render cumulative bucket counts', () => {
    const hist = registry.registerHistogram({
      name: 'test_request_duration_seconds',
      help: 'HTTP request duration',
      buckets: [0.1, 0.5, 1.0],
    });

    hist.observe(0.05, { route: '/healthz' });
    hist.observe(0.2, { route: '/healthz' });
    hist.observe(0.8, { route: '/healthz' });
    hist.observe(2.5, { route: '/healthz' });

    const rendered = registry.exportMetrics();
    expect(rendered).toContain('# TYPE test_request_duration_seconds histogram');
    expect(rendered).toContain('test_request_duration_seconds_bucket{route="/healthz",le="0.1"} 1');
    expect(rendered).toContain('test_request_duration_seconds_bucket{route="/healthz",le="0.5"} 2');
    expect(rendered).toContain('test_request_duration_seconds_bucket{route="/healthz",le="1"} 3');
    expect(rendered).toContain('test_request_duration_seconds_bucket{route="/healthz",le="+Inf"} 4');
    expect(rendered).toContain('test_request_duration_seconds_count{route="/healthz"} 4');
  });
});
