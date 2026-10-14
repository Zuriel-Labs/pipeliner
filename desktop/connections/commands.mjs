const protectedText = /(?:\b(?:bearer\s+|gh[pousr]_|sk-|(?:api[_ -]?key|token)\s*[:=])\S+|[A-Za-z0-9_-]{24,})/gi;
export function containsSecret(text) { return typeof text === 'string' && text.search(protectedText) !== -1; }
export function redactProtectedText(text) { return text.replace(protectedText, '[protected-looking text omitted]'); }

export function connectionCommand(text) {
  if (typeof text !== 'string' || text.length > 2000 || containsSecret(text)) return { message: 'Use the protected connection surface for keys. Nothing was saved or sent.' };
  const value = text.trim().replace(/[.!?]$/, '');
  const match = /^(?:(?:please|can you|i want to|i would like to|let me) )?(connect|reconnect|disconnect|cancel|test|check|refresh)(?: my)? (github(?: setup)?|codex|chatgpt|ollama(?: cloud)?)(?: connection| account)?(?: (?:with|using) ([a-z0-9_.:/-]{1,160}))?$/i.exec(value);
  if (!match) return { message: 'Choose GitHub, Codex or Ollama Cloud below, or ask to connect, check, test or disconnect one of them.' };
  const provider = match[2].toLowerCase(), verb = match[1].toLowerCase();
  const connection = provider === 'github setup' ? 'github-setup' : ['chatgpt', 'codex'].includes(provider) ? 'codex' : provider.startsWith('ollama') ? 'ollama' : 'github';
  const operation = { reconnect: 'connect', check: 'refresh', refresh: 'refresh' }[verb] ?? verb;
  if (match[3] && operation !== 'test') return { message: 'Choose one connection action. A model is selected when testing a provider.' };
  return { connection, operation, ...(match[3] ? { model: match[3] } : {}) };
}
