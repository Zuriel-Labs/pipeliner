import { containsSecret } from '../connections/commands.mjs';

export const updateShapes = Object.freeze({ view: [[], []], chat: [['text'], []], prepare: [['changes'], []],
  source: [['name'], []], reset: [[], []], apply: [[], ['hash']], cancel: [[], []], check: [[], []], stop: [[], []], install: [[], []],
  'removal-inspect': [[], []], 'removal-cancel': [[], []] });
export function updateCommand(text) {
  if (typeof text !== 'string' || text.length > 2000 || containsSecret(text) || /["`<>\n\r]/.test(text)) return null;
  const input = text.trim().replace(/[.!?]$/, ''); let match;
  if (/^(?:show|manage|open) (?:Desktop updates|Desktop update settings)$/i.test(input)) return { operation: 'view' };
  if ((match = /^(?:use|switch to) (?:the )?(Stable|Beta|Alpha) update channel$/i.exec(input)))
    return { operation: 'prepare', changes: { 'updates.channel': match[1].toLowerCase() } };
  if ((match = /^use Desktop update source (.{1,120})$/i.exec(input))) return { operation: 'source', name: match[1] };
  if (/^disable Desktop update checks$/i.test(input)) return { operation: 'source', name: null };
  if (/^reset (?:the )?Desktop update channel$/i.test(input)) return { operation: 'reset' };
  if (/^(?:apply|save) (?:this |the )?update change$/i.test(input)) return { operation: 'apply' };
  if (/^(?:cancel|discard) (?:this |the )?update change$/i.test(input)) return { operation: 'cancel' };
  if (/^check for Desktop updates$/i.test(input)) return { operation: 'check' };
  if (/^cancel Desktop update check$/i.test(input)) return { operation: 'stop' };
  if (/^update Desktop when idle$/i.test(input)) return { operation: 'install' };
  if (/^(?:review|inspect) Desktop removal$/i.test(input)) return { operation: 'removal-inspect' };
  if (/^(?:cancel|discard) Desktop removal$/i.test(input)) return { operation: 'removal-cancel' };
  return null;
}
