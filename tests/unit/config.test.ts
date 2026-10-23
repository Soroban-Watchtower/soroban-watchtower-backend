import { describe, it, expect } from 'vitest';
import { loadConfig, envSchema } from '../../src/config/env.js';

describe('Configuration & Environment Validation (Zod)', () => {
  const validMockEnv = {
    NODE_ENV: 'test',
    PORT: '5000',
    DATABASE_URL: 'postgresql://postgres:password@localhost:5432/test_db',
    REDIS_URL: 'redis://localhost:6379',
    SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
    ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    POLL_INTERVAL_MS: '3000',
    MAX_EVENTS_PER_BATCH: '50',
    LOG_LEVEL: 'debug',
  };

  it('should successfully parse and coerce valid configuration', () => {
    const config = loadConfig(validMockEnv);

    expect(config.NODE_ENV).toBe('test');
    expect(config.PORT).toBe(5000); // Coerced from string to number
    expect(config.DATABASE_URL).toBe(validMockEnv.DATABASE_URL);
    expect(config.REDIS_URL).toBe(validMockEnv.REDIS_URL);
    expect(config.SOROBAN_RPC_URL).toBe(validMockEnv.SOROBAN_RPC_URL);
    expect(config.ENCRYPTION_KEY).toBe(validMockEnv.ENCRYPTION_KEY);
    expect(config.POLL_INTERVAL_MS).toBe(3000); // Coerced to number
    expect(config.MAX_EVENTS_PER_BATCH).toBe(50); // Coerced to number
    expect(config.LOG_LEVEL).toBe('debug');
  });

  it('should apply intelligent default values when optional fields are omitted', () => {
    const minimalEnv = {
      DATABASE_URL: 'postgresql://postgres:password@localhost:5432/test_db',
      REDIS_URL: 'redis://localhost:6379',
      SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    };

    const config = loadConfig(minimalEnv);

    expect(config.PORT).toBe(4000);
    expect(config.NODE_ENV).toBe('development');
    expect(config.POLL_INTERVAL_MS).toBe(5000);
    expect(config.MAX_EVENTS_PER_BATCH).toBe(100);
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('should throw descriptive error when DATABASE_URL is missing', () => {
    const invalidEnv = { ...validMockEnv };
    delete (invalidEnv as any).DATABASE_URL;

    expect(() => loadConfig(invalidEnv)).toThrowError(/DATABASE_URL is required/);
  });

  it('should throw descriptive error when SOROBAN_RPC_URL is not a valid URL', () => {
    const invalidEnv = {
      ...validMockEnv,
      SOROBAN_RPC_URL: 'not-a-valid-url',
    };

    expect(() => loadConfig(invalidEnv)).toThrowError(/SOROBAN_RPC_URL must be a valid URL/);
  });

  it('should reject ENCRYPTION_KEY that is not a 64-character hex string', () => {
    // Key that is too short
    const shortKeyEnv = {
      ...validMockEnv,
      ENCRYPTION_KEY: 'too_short_key',
    };
    expect(() => loadConfig(shortKeyEnv)).toThrowError(/ENCRYPTION_KEY must be a 64-character hex string/);

    // Key with invalid non-hex characters
    const nonHexKeyEnv = {
      ...validMockEnv,
      ENCRYPTION_KEY: 'g'.repeat(64), // 'g' is not valid hex
    };
    expect(() => loadConfig(nonHexKeyEnv)).toThrowError(/ENCRYPTION_KEY must be a valid hexadecimal string/);
  });
});
