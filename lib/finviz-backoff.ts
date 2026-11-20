const FALLBACK_MS = 15 * 60 * 1000;
const shared = globalThis as typeof globalThis & { flashscopeFinvizRetryAt?: number };

export function finvizRetryAt() {
  return (shared.flashscopeFinvizRetryAt ?? 0) > Date.now() ? shared.flashscopeFinvizRetryAt! : 0;
}

export class FinvizRateLimitError extends Error {
  constructor() {
    super("Finviz is temporarily rate-limiting requests.");
  }
}

export async function fetchFinviz(url: string, init: RequestInit) {
  if (finvizRetryAt()) throw new FinvizRateLimitError();
  const response = await fetch(url, init);
  if (response.status === 429) {
    const now = Date.now();
    const retry = response.headers.get("Retry-After")?.trim();
    const deadline = retry
      ? /^\d+$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry)
      : NaN;
    const next = Number.isFinite(deadline) && deadline <= 8.64e15
      ? Math.max(now + 1000, deadline)
      : now + FALLBACK_MS;
    shared.flashscopeFinvizRetryAt = Math.max(shared.flashscopeFinvizRetryAt ?? 0, next);
    throw new FinvizRateLimitError();
  }
  return response;
}
