import { isIP } from 'node:net';

const SENSITIVE_KEY_PATTERN =
  /password|token|secret|auth|private|credential|signature|apikey|api_key|webhook/i;

const DB_URL_CREDENTIAL_PATTERN = /:\/\/([^:]+):([^@]+)@/g;
const BEARER_TOKEN_PATTERN = /Bearer\s+([A-Za-z0-9\-_.]+)/gi;

/**
 * Sanitizes connection strings and URLs by masking embedded credentials.
 */
export function sanitizeUrl(urlStr: string): string {
  if (typeof urlStr !== 'string') return urlStr;
  return urlStr.replace(DB_URL_CREDENTIAL_PATTERN, '://$1:[REDACTED]@');
}

/**
 * Recursively redacts sensitive fields, credentials, and tokens from any object or payload.
 * Safely handles circular references and arbitrary depth.
 */
export function redactSensitiveData(obj: any, seen = new WeakSet()): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    let sanitized = sanitizeUrl(obj);
    sanitized = sanitized.replace(BEARER_TOKEN_PATTERN, 'Bearer [REDACTED]');
    return sanitized;
  }

  if (typeof obj !== 'object') {
    return obj;
  }

  if (obj instanceof Date || obj instanceof RegExp || obj instanceof Error) {
    return obj;
  }

  if (seen.has(obj)) {
    return '[CIRCULAR]';
  }
  seen.add(obj);

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitiveData(item, seen));
  }

  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEY_PATTERN.test(key) && (typeof value !== 'object' || value === null)) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = redactSensitiveData(value, seen);
    }
  }

  return result;
}
