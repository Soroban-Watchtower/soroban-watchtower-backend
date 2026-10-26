import pino from 'pino';
import { config } from '../config/env.js';
import { redactSensitiveData } from './errorRedaction.js';

export const logger = pino({
  level: config.LOG_LEVEL || 'info',
  formatters: {
    log(object: any) {
      return redactSensitiveData(object);
    },
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'secret',
      'password',
      'token',
      'key',
      'apiKey',
      'botToken',
      'encryptionKey',
      'destination',
    ],
    censor: '[REDACTED]',
  },
  transport:
    config.NODE_ENV === 'development'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
});

export default logger;
