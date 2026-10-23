import crypto from 'crypto';
import { config } from '../config/env';

/**
 * AES-256-GCM Configuration constants
 * - 256-bit key (32 bytes)
 * - 96-bit Initialization Vector (12 bytes, NIST standard for GCM)
 * - 128-bit Authentication Tag (16 bytes)
 */
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;

/**
 * Resolves a 32-byte Buffer encryption key from a 64-character hex string.
 * Defaults to config.ENCRYPTION_KEY if keyHex is not provided.
 */
function resolveKeyBuffer(keyHex?: string): Buffer {
  const hex = keyHex || config.ENCRYPTION_KEY;
  if (!hex || typeof hex !== 'string') {
    throw new Error('Encryption key must be provided or configured via ENCRYPTION_KEY');
  }
  if (hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('Encryption key must be a 64-character hexadecimal string (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * Output format: `${ivHex}:${authTagHex}:${ciphertextHex}`
 *
 * @param plaintext The string to encrypt
 * @param keyHex Optional 32-byte hex key (defaults to config.ENCRYPTION_KEY)
 * @returns Serialized encrypted payload string
 */
export function encrypt(plaintext: string, keyHex?: string): string {
  if (typeof plaintext !== 'string') {
    throw new TypeError('Plaintext must be a string');
  }

  const key = resolveKeyBuffer(keyHex);
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH_BYTES,
  });

  const encryptedBuffer = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encryptedBuffer.toString('hex')}`;
}

/**
 * Decrypts an AES-256-GCM encrypted payload produced by `encrypt()`.
 *
 * @param encryptedPayload Serialized string in `${ivHex}:${authTagHex}:${ciphertextHex}` format
 * @param keyHex Optional 32-byte hex key (defaults to config.ENCRYPTION_KEY)
 * @returns The original plaintext string
 */
export function decrypt(encryptedPayload: string, keyHex?: string): string {
  if (typeof encryptedPayload !== 'string') {
    throw new TypeError('Encrypted payload must be a string');
  }

  const parts = encryptedPayload.split(':');
  if (parts.length !== 3) {
    throw new Error(
      'Invalid encrypted payload format. Expected format: "iv:authTag:ciphertext"'
    );
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;

  if (!ivHex || !authTagHex) {
    throw new Error('Malformed encrypted payload: missing IV or auth tag');
  }

  const key = resolveKeyBuffer(keyHex);
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');

  if (iv.length !== IV_LENGTH_BYTES) {
    throw new Error(`Invalid IV length: expected ${IV_LENGTH_BYTES} bytes`);
  }
  if (authTag.length !== AUTH_TAG_LENGTH_BYTES) {
    throw new Error(`Invalid Auth Tag length: expected ${AUTH_TAG_LENGTH_BYTES} bytes`);
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH_BYTES,
  });

  decipher.setAuthTag(authTag);

  try {
    const decryptedBuffer = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decryptedBuffer.toString('utf8');
  } catch (err: any) {
    throw new Error(
      `Decryption failed: authenticated data verification failed or payload corrupted. Details: ${err.message}`
    );
  }
}
