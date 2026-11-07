import { ChannelType, NotifierPlugin } from '../types/index.js';
import { DiscordNotifier, DiscordNotifierOptions } from './discord.js';
import { WebhookNotifier, WebhookNotifierOptions } from './webhook.js';
import { TelegramNotifier, TelegramNotifierOptions } from './telegram.js';
import { SlackNotifier, SlackNotifierOptions } from './slack.js';
import { PagerDutyNotifier, PagerDutyNotifierOptions } from './pagerduty.js';

export * from './ssrfValidator.js';
export * from './webhook.js';
export * from './discord.js';
export * from './telegram.js';
export * from './slack.js';
export * from './pagerduty.js';

export interface DefaultNotifierRegistryOptions {
  discord?: DiscordNotifierOptions;
  webhook?: WebhookNotifierOptions;
  telegram?: TelegramNotifierOptions;
  slack?: SlackNotifierOptions;
  pagerduty?: PagerDutyNotifierOptions;
}

/**
 * Creates and registers the default suite of notification channel plugins
 * mapping ChannelType ('DISCORD' | 'WEBHOOK' | 'TELEGRAM' | 'SLACK' | 'PAGERDUTY') to their respective NotifierPlugin.
 */
export function createDefaultNotifierRegistry(
  options: DefaultNotifierRegistryOptions = {}
): Map<ChannelType, NotifierPlugin> {
  const registry = new Map<ChannelType, NotifierPlugin>();

  registry.set('DISCORD', new DiscordNotifier(options.discord));
  registry.set('WEBHOOK', new WebhookNotifier(options.webhook));
  registry.set('TELEGRAM', new TelegramNotifier(options.telegram));
  registry.set('SLACK', new SlackNotifier(options.slack));
  registry.set('PAGERDUTY', new PagerDutyNotifier(options.pagerduty));

  return registry;
}
