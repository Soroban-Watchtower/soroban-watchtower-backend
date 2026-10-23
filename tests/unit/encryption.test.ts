import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from '../../src/db/encryption.js';

describe('AES-256-GCM Secret Encryption & Decryption (src/db/encryption)', () => {
  const customKey = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
  const alternateKey = '11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff';

  it('should encrypt and decrypt plaintext to an exact match using default key', () => {
    const secret = 'whsec_9b8f7e6d5c4b3a210fedcba987654321';
    const encrypted = encrypt(secret);

    expect(encrypted).not.toBe(secret);
    expect(typeof encrypted).toBe('string');
    expect(encrypted.split(':')).toHaveLength(3);

    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(secret);
  });

  it('should encrypt and decrypt using an explicitly provided custom 256-bit key', () => {
    const botToken = '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_1234567';
    const encrypted = encrypt(botToken, customKey);

    const decrypted = decrypt(encrypted, customKey);
    expect(decrypted).toBe(botToken);
  });

  it('should produce distinct ciphertexts for identical inputs due to randomized IV', () => {
    const text = 'same-confidential-webhook-secret';
    const cipher1 = encrypt(text);
    const cipher2 = encrypt(text);

    expect(cipher1).not.toBe(cipher2);

    // Both must decrypt to the exact original text
    expect(decrypt(cipher1)).toBe(text);
    expect(decrypt(cipher2)).toBe(text);
  });

  it('should successfully round-trip edge case strings (empty, unicode, JSON, long secrets)', () => {
    const edgeCases = [
      '',
      '   ',
      '🌟🚀 Soroban Watchdog Unicode Security Test 🔒🛡️',
      JSON.stringify({ apiKey: 'k_live_9999', endpoint: 'https://api.example.com/webhook' }),
      'a'.repeat(5000),
    ];

    for (const testCase of edgeCases) {
      const encrypted = encrypt(testCase);
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(testCase);
    }
  });

  it('should fail authentication and throw when decrypting with the wrong key', () => {
    const payload = 'my-super-secret-token';
    const encrypted = encrypt(payload, customKey);

    expect(() => decrypt(encrypted, alternateKey)).toThrowError(/Decryption failed/i);
  });

  it('should fail authentication when ciphertext or auth tag is tampered with', () => {
    const secret = 'tamper-resistant-secret';
    const encrypted = encrypt(secret);
    const [iv, authTag, ciphertext] = encrypted.split(':');

    // Tamper with ciphertext by corrupting last char
    const tamperedCiphertext =
      ciphertext.slice(0, -1) + (ciphertext.endsWith('0') ? '1' : '0');
    const tamperedPayload = `${iv}:${authTag}:${tamperedCiphertext}`;

    expect(() => decrypt(tamperedPayload)).toThrowError(/Decryption failed/i);

    // Tamper with auth tag
    const tamperedTag =
      authTag.slice(0, -1) + (authTag.endsWith('0') ? '1' : '0');
    const tamperedTagPayload = `${iv}:${tamperedTag}:${ciphertext}`;

    expect(() => decrypt(tamperedTagPayload)).toThrowError(/Decryption failed/i);
  });

  it('should throw descriptive errors on malformed payloads', () => {
    expect(() => decrypt('not-a-valid-payload')).toThrowError(/Invalid encrypted payload format/);
    expect(() => decrypt('iv_only:tag_only')).toThrowError(/Invalid encrypted payload format/);
    expect(() => decrypt('::')).toThrowError(/Malformed encrypted payload/);
    expect(() => (decrypt as any)(12345)).toThrowError(/Encrypted payload must be a string/);
    expect(() => (encrypt as any)(null)).toThrowError(/Plaintext must be a string/);
  });

  it('should reject invalid encryption keys', () => {
    expect(() => encrypt('test', 'short-key')).toThrowError(/64-character hexadecimal string/);
    expect(() => encrypt('test', 'z'.repeat(64))).toThrowError(/64-character hexadecimal string/);
  });
});
