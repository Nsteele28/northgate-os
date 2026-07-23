// ── Shared HTTP client: retry, backoff, health heartbeats ──────────

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  onAttemptFailure?: (attempt: number, error: string) => Promise<void>;
}

export class IntegrationError extends Error {
  constructor(public service: string, public status: number | undefined, message: string) {
    super(`[${service}] ${message}`);
  }
}

export async function withRetry<T>(
  service: string,
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  const base = opts.baseDelayMs ?? 500;
  let lastError = '';
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await opts.onAttemptFailure?.(attempt, lastError);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, base * 2 ** (attempt - 1)));
      }
    }
  }
  throw new IntegrationError(service, undefined, `failed after ${retries} attempts: ${lastError}`);
}

export async function httpJson(
  service: string,
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 15_000);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      throw new IntegrationError(service, res.status, `${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}
