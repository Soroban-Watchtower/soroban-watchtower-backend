import dotenv from 'dotenv';
import { z } from 'zod';

// Load variables from .env file if present
dotenv.config();

/**
 * Zod validation schema for all environment variables.
 * Enforces types, default values, and format checks.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  // Persistence
  DATABASE_URL: z
    .string({ required_error: 'DATABASE_URL is required' })
    .min(1, 'DATABASE_URL cannot be empty'),
  REDIS_URL: z
    .string({ required_error: 'REDIS_URL is required' })
    .min(1, 'REDIS_URL cannot be empty'),

  // Stellar & Soroban RPC
  SOROBAN_RPC_URL: z.string().url('SOROBAN_RPC_URL must be a valid URL'),

  // AES-256-GCM Secret Encryption Key (Must be 32 bytes hex = 64 characters)
  ENCRYPTION_KEY: z
    .string()
    .length(64, 'ENCRYPTION_KEY must be a 64-character hex string (32 bytes)')
    .regex(/^[0-9a-fA-F]+$/, 'ENCRYPTION_KEY must be a valid hexadecimal string'),

  // Ingestion settings
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  MAX_EVENTS_PER_BATCH: z.coerce.number().int().positive().default(100),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type AppConfig = z.infer<typeof envSchema>;

/**
 * Validates and returns configuration.
 * Throws a formatted, human-readable error if validation fails.
 */
export function loadConfig(sourceEnv: Record<string, any> = process.env): AppConfig {
  const result = envSchema.safeParse(sourceEnv);

  if (!result.success) {
    const errorDetails = result.error.issues
      .map((issue) => `  - [${issue.path.join('.')}]: ${issue.message}`)
      .join('\n');

    const formattedMessage = `\n❌ FATAL: Environment Configuration Validation Failed:\n${errorDetails}\n`;
    throw new Error(formattedMessage);
  }

  return result.data;
}

// Export default singleton instance initialized from process.env
let configInstance: AppConfig | null = null;

export const config = new Proxy({} as AppConfig, {
  get(_target, prop: string | symbol) {
    if (!configInstance) {
      configInstance = loadConfig(process.env);
    }
    return (configInstance as any)[prop];
  },
});
