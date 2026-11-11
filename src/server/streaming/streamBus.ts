import { EventEmitter } from 'node:events';
import { AlertPayload, DecodedSorobanEvent, StreamFilter } from '../../types/index.js';
import { sseActiveConnections, sseStreamedMessagesTotal } from '../../observability/metrics.js';
import { logger } from '../../observability/logger.js';

export interface StreamStats {
  activeConnections: Record<string, number>;
  totalConnections: number;
}

/**
 * High-performance, in-memory & pub/sub streaming bus.
 * Manages push-based Server-Sent Events (SSE) subscriptions for real-time
 * security alerts, decoded Soroban contract events, and live telemetry pulses.
 */
export class StreamBus {
  private readonly emitter = new EventEmitter();
  private readonly connectionCounts = new Map<string, number>();

  constructor() {
    // Prevent unhandled listener limits during high concurrent streaming loads
    this.emitter.setMaxListeners(1000);
  }

  /**
   * Formats a standard Server-Sent Events (SSE) frame according to W3C specification.
   */
  static formatSseFrame(eventName: string, data: any, id?: string): string {
    const lines: string[] = [];
    if (id) {
      lines.push(`id: ${id}`);
    }
    lines.push(`event: ${eventName}`);
    lines.push(`data: ${JSON.stringify(data)}`);
    return lines.join('\n') + '\n\n';
  }

  /**
   * Broadcasts a triggered security alert to all active stream listeners.
   */
  publishAlert(alert: AlertPayload): void {
    sseStreamedMessagesTotal.inc({ stream_type: 'alerts', event_type: alert.severity });
    this.emitter.emit('alert', alert);
  }

  /**
   * Broadcasts a newly ingested and decoded Soroban contract event.
   */
  publishEvent(event: DecodedSorobanEvent): void {
    sseStreamedMessagesTotal.inc({ stream_type: 'events', event_type: event.type });
    this.emitter.emit('event', event);
  }

  /**
   * Broadcasts a real-time contract telemetry update.
   */
  publishTelemetry(contractId: string, telemetry: Record<string, any>): void {
    sseStreamedMessagesTotal.inc({ stream_type: 'telemetry', event_type: 'pulse' });
    this.emitter.emit('telemetry', { contractId, telemetry, timestamp: new Date().toISOString() });
  }

  /**
   * Broadcasts an automated defensive action (circuit-breaker / pause invocation).
   */
  publishDefensiveAction(action: Record<string, any>): void {
    sseStreamedMessagesTotal.inc({ stream_type: 'defensive_action', event_type: action.status || 'unknown' });
    this.emitter.emit('defensive_action', action);
  }

  /**
   * Subscribes a client to real-time security alerts with optional filtering.
   */
  subscribeAlerts(
    listener: (alert: AlertPayload) => void,
    filter?: StreamFilter
  ): () => void {
    const handler = (alert: AlertPayload) => {
      if (filter?.contractId && alert.contractId !== filter.contractId) {
        return;
      }
      if (filter?.severity && alert.severity !== filter.severity) {
        return;
      }
      try {
        listener(alert);
      } catch (err: any) {
        logger.error({ err, alertId: alert.alertId }, '[StreamBus] Error in alert subscriber callback');
      }
    };

    this.emitter.on('alert', handler);
    this.incrementConnection('alerts');

    return () => {
      this.emitter.off('alert', handler);
      this.decrementConnection('alerts');
    };
  }

  /**
   * Subscribes a client to real-time decoded contract events with optional filtering.
   */
  subscribeEvents(
    listener: (event: DecodedSorobanEvent) => void,
    filter?: StreamFilter
  ): () => void {
    const handler = (event: DecodedSorobanEvent) => {
      if (filter?.contractId && event.contractId !== filter.contractId) {
        return;
      }
      if (filter?.eventType && event.type !== filter.eventType) {
        return;
      }
      try {
        listener(event);
      } catch (err: any) {
        logger.error({ err, eventId: event.id }, '[StreamBus] Error in event subscriber callback');
      }
    };

    this.emitter.on('event', handler);
    this.incrementConnection('events');

    return () => {
      this.emitter.off('event', handler);
      this.decrementConnection('events');
    };
  }

  /**
   * Subscribes a client to live contract telemetry pulses.
   */
  subscribeTelemetry(
    listener: (telemetryData: { contractId: string; telemetry: Record<string, any>; timestamp: string }) => void,
    filter?: StreamFilter
  ): () => void {
    const handler = (data: { contractId: string; telemetry: Record<string, any>; timestamp: string }) => {
      if (filter?.contractId && data.contractId !== filter.contractId) {
        return;
      }
      try {
        listener(data);
      } catch (err: any) {
        logger.error({ err, contractId: data.contractId }, '[StreamBus] Error in telemetry subscriber callback');
      }
    };

    this.emitter.on('telemetry', handler);
    this.incrementConnection('telemetry');

    return () => {
      this.emitter.off('telemetry', handler);
      this.decrementConnection('telemetry');
    };
  }

  incrementConnection(streamType: string): void {
    const current = this.connectionCounts.get(streamType) || 0;
    this.connectionCounts.set(streamType, current + 1);
    sseActiveConnections.inc({ stream_type: streamType });
  }

  decrementConnection(streamType: string): void {
    const current = this.connectionCounts.get(streamType) || 0;
    if (current > 0) {
      this.connectionCounts.set(streamType, current - 1);
      sseActiveConnections.dec({ stream_type: streamType });
    }
  }

  getStats(): StreamStats {
    const active: Record<string, number> = {};
    let total = 0;
    for (const [key, val] of this.connectionCounts.entries()) {
      active[key] = val;
      total += val;
    }
    return { activeConnections: active, totalConnections: total };
  }
}

// Global stream bus singleton instance
let defaultStreamBus: StreamBus | null = null;

export function getStreamBus(): StreamBus {
  if (!defaultStreamBus) {
    defaultStreamBus = new StreamBus();
  }
  return defaultStreamBus;
}

