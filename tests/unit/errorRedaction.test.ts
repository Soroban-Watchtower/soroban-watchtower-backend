import { describe, it, expect } from 'vitest';
import { redactSensitiveData, sanitizeUrl } from '../../src/observability/errorRedaction.js';

describe('Error & Sensitive Data Redaction (src/observability/errorRedaction)', () => {
  it('should mask credentials embedded in database URLs', () => {
    const rawUrl = 'postgresql://postgres:mySuperSecretPassword123@db.internal.host:5432/soroban_db';
    const sanitized = sanitizeUrl(rawUrl);
    expect(sanitized).toBe('postgresql://postgres:[REDACTED]@db.internal.host:5432/soroban_db');
    expect(sanitized).not.toContain('mySuperSecretPassword123');
  });

  it('should redact sensitive keys across nested objects', () => {
    const payload = {
      username: 'watcher',
      apiKey: 'k_live_999999999999',
      secret: 'whsec_abcdef123456789',
      auth: {
        password: 'mypassword',
        token: 'bearer-token-12345',
      },
      contract: {
        id: 'CA3D5KRYMCMFZK54DNYNO3TVQAS4PU2QLAXU6VO6JMQG2RCHWHW32VN4',
        name: 'USDC Vault',
      },
    };

    const redacted = redactSensitiveData(payload);

    expect(redacted.username).toBe('watcher');
    expect(redacted.apiKey).toBe('[REDACTED]');
    expect(redacted.secret).toBe('[REDACTED]');
    expect(redacted.auth.password).toBe('[REDACTED]');
    expect(redacted.auth.token).toBe('[REDACTED]');
    expect(redacted.contract.id).toBe('CA3D5KRYMCMFZK54DNYNO3TVQAS4PU2QLAXU6VO6JMQG2RCHWHW32VN4');
  });

  it('should handle circular object references gracefully without infinite loops', () => {
    const circularObj: any = { name: 'cyclic-node' };
    circularObj.self = circularObj;

    const result = redactSensitiveData(circularObj);
    expect(result.name).toBe('cyclic-node');
    expect(result.self).toBe('[CIRCULAR]');
  });
});
