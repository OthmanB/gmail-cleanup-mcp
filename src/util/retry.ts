import { sleepMs } from './sleep.js';

export interface RetryConfig {
  maxRetries: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  minDelayMs: number;
}

export interface RetryContext {
  operation: string;
}

export async function withRetries<T>(
  fn: () => Promise<T>,
  cfg: RetryConfig,
  ctx: RetryContext,
  shouldRetry: (err: unknown) => boolean
): Promise<T> {
  let attempt = 0;
  // Always respect a small delay between calls.
  await sleepMs(cfg.minDelayMs);

  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!shouldRetry(err) || attempt >= cfg.maxRetries) {
        throw annotateError(err, ctx, attempt);
      }

      const backoff = computeBackoffMs(cfg.backoffBaseMs, cfg.backoffMaxMs, attempt);
      await sleepMs(backoff);
      attempt += 1;
    }
  }
}

function computeBackoffMs(baseMs: number, maxMs: number, attempt: number): number {
  const exp = Math.min(maxMs, baseMs * Math.pow(2, attempt));
  const jitter = Math.floor(Math.random() * Math.min(250, exp));
  return Math.min(maxMs, exp + jitter);
}

function annotateError(err: unknown, ctx: RetryContext, attempt: number): Error {
  const base = err instanceof Error ? err : new Error(String(err));
  base.message = `${ctx.operation} failed after attempts=${attempt + 1}: ${base.message}`;
  return base;
}
