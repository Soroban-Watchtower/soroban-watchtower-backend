import { describe, it, expect, vi } from 'vitest';
import { FailedEventManager } from '../../src/ingest/failedEventManager.js';

describe('Dead-Letter Failed Event Manager (src/ingest/failedEventManager)', () => {
  it('should quarantine failed events with error stack and status PENDING', async () => {
    const mockPrisma = {
      contract: {
        upsert: vi.fn().mockResolvedValue({ id: 'C123' }),
      },
      failedEvent: {
        create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'fail-1', ...data })),
      },
    } as any;

    const manager = new FailedEventManager(mockPrisma);
    const testError = new Error('Simulation of catastrophic XDR decode failure');

    const result = await manager.recordFailedEvent({
      contractId: 'C123',
      eventId: '100-1-0',
      eventType: 'contract',
      rawPayload: { xdr: 'corrupted-base64' },
      error: testError,
    });

    expect(result.id).toBe('fail-1');
    expect(result.status).toBe('PENDING');
    expect(result.errorLog).toContain('Simulation of catastrophic XDR decode failure');
    expect(mockPrisma.contract.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'C123' } }));
    expect(mockPrisma.failedEvent.create).toHaveBeenCalled();
  });

  it('should mark failed event as resolved upon successful replay', async () => {
    const mockPrisma = {
      failedEvent: {
        update: vi.fn().mockResolvedValue({ id: 'fail-1', status: 'RESOLVED' }),
      },
    } as any;

    const manager = new FailedEventManager(mockPrisma);
    const resolved = await manager.markResolved('fail-1');

    expect(resolved.status).toBe('RESOLVED');
    expect(mockPrisma.failedEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'fail-1' },
        data: expect.objectContaining({ status: 'RESOLVED' }),
      })
    );
  });

  it('should increment retry count when replay fails', async () => {
    const mockPrisma = {
      failedEvent: {
        update: vi.fn().mockResolvedValue({ id: 'fail-1', retryCount: 1 }),
      },
    } as any;

    const manager = new FailedEventManager(mockPrisma);
    const updated = await manager.recordReplayFailure('fail-1', 'Still broken');

    expect(updated.retryCount).toBe(1);
    expect(mockPrisma.failedEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'fail-1' },
        data: expect.objectContaining({
          retryCount: { increment: 1 },
          errorLog: 'Still broken',
        }),
      })
    );
  });
});
