import { containsSecret } from '../connections/commands.mjs';
export const schedulingShapes = { chat: [['text'], []], view: [[], ['scope']], prepare: [['changes'], []], inherit: [[], []], apply: [[], ['hash']], cancel: [[], []], 'run-now': [[], []] };
export function schedulingCommand(text) {
  if (typeof text !== 'string' || text.length > 2000 || containsSecret(text) || /["`<>\n\r]/.test(text)) return null;
  let input = text.trim().replace(/[.!?]$/, ''), scope;
  if (/ for all repositories$/i.test(input)) { input = input.replace(/ for all repositories$/i, ''); scope = 'global'; }
  else if (/ for this repository$/i.test(input)) { input = input.replace(/ for this repository$/i, ''); scope = 'repository'; }
  const prepare = changes => ({ operation: 'prepare', changes, ...(scope ? { scope } : {}) });
  if (/^(show|inspect) (the )?schedul(e|ing)$/i.test(input)) return { operation: 'view', ...(scope ? { scope } : {}) };
  if (/^run now$/i.test(input)) return { operation: 'run-now' };
  if (/^apply (this |the )?schedule$/i.test(input)) return { operation: 'apply' };
  if (/^cancel (this |the )?schedule$/i.test(input)) return { operation: 'cancel' };
  if (/^(inherit|reset to) (the )?global schedule$/i.test(input)) return { operation: 'inherit' };
  if (/^(enable|disable) scheduled checks$/i.test(input)) return prepare({ 'scheduling.enabled': /^enable/i.test(input) });
  let match = /^check every (\d+) minutes?$/i.exec(input);
  if (match) return prepare({ 'scheduling.mode': 'interval', 'scheduling.intervalMinutes': Number(match[1]) });
  match = /^schedule (daily|weekdays|weekends) at (\d{2}:\d{2})(?: in ([A-Za-z0-9_+\-/]+))?$/i.exec(input);
  if (match) return prepare({ 'scheduling.mode': 'calendar', 'scheduling.calendar': { days: match[1].toLowerCase() === 'daily' ? [0, 1, 2, 3, 4, 5, 6] : match[1].toLowerCase() === 'weekdays' ? [1, 2, 3, 4, 5] : [0, 6], time: match[2] }, ...(match[3] ? { 'scheduling.timezone': match[3] } : {}) });
  if (/^wait for (the )?next check after completion$/i.test(input)) return prepare({ 'scheduling.afterCompletion': 'next-check' });
  if (/^check immediately after completion$/i.test(input)) return prepare({ 'scheduling.afterCompletion': 'immediate' });
  return null;
}
