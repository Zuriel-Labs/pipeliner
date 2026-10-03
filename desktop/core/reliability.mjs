export const isTransient = error => /^(?:http-(?:408|429|5\d\d)|timeout|transport-failed|read-failed)$/.test(error?.message ?? '');

// Only a bounded timing value crosses the transport boundary, never response text.
export function retryAfter(response, now = Date.now()) {
  const value = response.headers?.get('retry-after');
  if (typeof value !== 'string' || value.length > 80) return null;
  const delay = /^\d{1,9}$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isSafeInteger(delay) && delay >= 0 ? delay : null;
}

export function retryDelay(attempt, guidance = null, random = Math.random) {
  const base = attempt === 1 ? 2000 : 8000;
  return Math.max(Math.round(base * (0.9 + random() * 0.2)), Number.isSafeInteger(guidance) && guidance >= 0 ? guidance : 0);
}
