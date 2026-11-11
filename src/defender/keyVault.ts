import { Keypair } from '@stellar/stellar-sdk';
import { logger } from '../observability/logger.js';
import { decrypt } from '../db/encryption.js';

export interface KeyVaultOptions {
  secretKey?: string;
  encryptedSecretKey?: string;
}

/**
 * DefenderKeyVault
 * Manages the dedicated Guardian / Defender signing keypair responsible for
 * executing on-chain emergency circuit-breakers and pause invocations.
 */
export class DefenderKeyVault {
  private keypair: Keypair | null = null;
  private readonly configured: boolean = false;

  constructor(options: KeyVaultOptions = {}) {
    const rawSecret =
      options.secretKey ||
      process.env.DEFENDER_SECRET_KEY ||
      (options.encryptedSecretKey ? this.decryptSecret(options.encryptedSecretKey) : undefined);

    if (rawSecret && rawSecret.trim()) {
      try {
        const trimmed = rawSecret.trim();
        if (!trimmed.startsWith('S') || trimmed.length !== 56) {
          throw new Error('Invalid Stellar secret key format. Must be 56 characters starting with S.');
        }
        this.keypair = Keypair.fromSecret(trimmed);
        this.configured = true;
        logger.info(
          { publicKey: this.keypair.publicKey() },
          '[KeyVault] Defender Keypair successfully initialized'
        );
      } catch (err: any) {
        logger.error({ err }, `[KeyVault] Failed to parse defender secret key: ${err.message}`);
        this.keypair = Keypair.random();
        this.configured = false;
      }
    } else {
      // In test/local environments where no DEFENDER_SECRET_KEY is specified, generate a random ephemeral keypair
      this.keypair = Keypair.random();
      this.configured = false;
      logger.info(
        { publicKey: this.keypair.publicKey() },
        '[KeyVault] No DEFENDER_SECRET_KEY configured; running in simulation/ephemeral mode'
      );
    }
  }

  private decryptSecret(encryptedSecret: string): string | undefined {
    try {
      return decrypt(encryptedSecret);
    } catch (err: any) {
      logger.error({ err }, '[KeyVault] Failed to decrypt encrypted defender secret key');
      return undefined;
    }
  }

  isConfigured(): boolean {
    return this.configured;
  }

  getPublicKey(): string {
    return this.keypair!.publicKey();
  }

  getKeypair(): Keypair {
    return this.keypair!;
  }
}

// Singleton instance
let defaultVault: DefenderKeyVault | null = null;

export function getDefenderKeyVault(options?: KeyVaultOptions): DefenderKeyVault {
  if (!defaultVault || options) {
    defaultVault = new DefenderKeyVault(options);
  }
  return defaultVault;
}
