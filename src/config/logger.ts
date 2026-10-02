import pino from 'pino';
import { env, isProd, isTest } from './env';

export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  transport: isProd ? undefined : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
  redact: ['req.headers.authorization', 'password', 'passwordHash', 'refreshToken'],
});
