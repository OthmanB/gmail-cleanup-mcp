import pino, { type Logger } from 'pino';
import { type AppConfig } from './config.js';

export function createLogger(config: AppConfig): Logger {
  // IMPORTANT: log to stderr so we don't corrupt MCP stdio protocol.
  const destination = pino.destination({ fd: 2, sync: false });
  return pino(
    {
      level: config.logging.level,
      base: {
        service: 'gmail-cleanup-mcp',
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level(label) {
          return { level: label };
        },
      },
    },
    destination
  );
}
