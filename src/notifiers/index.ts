import { ChannelType, NotifierPlugin } from '../types/index.js';
import { DiscordNotifier, DiscordNotifierOptions } from './discord.js';
import { WebhookNotifier, WebhookNotifierOptions } from './webhook.js';
import { TelegramNotifier, TelegramNotifierOptions } from './telegram.js';

export * from './ssrfValidator.js';
export * from './webhook.js';
export * from './discord.js';
export * from './telegram.js';

export interface DefaultNotifierRegistryOptions {
  discord?: DiscordNotifierOptions;
  webhook?: WebhookNotifierOptions;
  telegram?: TelegramNotifierOptions;
}

/**
 * Creates and registers the default suite of notification channel plugins
 * mapping ChannelType ('DISCORD' | 'WEBHOOK' | 'TELEGRAM') to their respective NotifierPlugin.
 */
export function createDefaultNotifierRegistry(
  options: DefaultNotifierRegistryOptions = {}
): Map<ChannelType, NotifierPlugin> {
  const registry = new Map<ChannelType, NotifierPlugin>();

  registry.set('DISCORD', new DiscordNotifier(options.discord));
  registry.set('WEBHOOK', new WebhookNotifier(options.webhook));
  registry.set('TELEGRAM', new TelegramNotifier(options.telegram));

  return registry;
}
