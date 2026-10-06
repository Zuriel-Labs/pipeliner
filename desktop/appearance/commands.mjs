import { containsSecret } from '../connections/commands.mjs';

export const appearanceKeys = Object.freeze(['appearance.theme', 'appearance.density', 'appearance.textScale', 'appearance.motion', 'appearance.technicalDetails']);
export const notificationKey = 'appearance.repositoryNotifications';
export const appearanceShapes = Object.freeze({ view: [[], ['scope']], chat: [['text'], []], prepare: [['changes'], ['scope']], reset: [[], ['scope']], apply: [[], ['hash']], cancel: [[], []] });
export function appearanceCommand(text) {
  if (typeof text !== 'string' || text.length > 2000 || containsSecret(text) || /["`<>\n\r]/.test(text)) return null;
  const input = text.trim().replace(/[.!?]$/, ''); let match;
  if (/^(?:show|manage|open) (?:appearance|accessibility|appearance and accessibility)(?: settings)?$/i.test(input)) return { operation: 'view' };
  if ((match = /^(show|hide) technical details$/i.exec(input))) return { operation: 'prepare', changes: { 'appearance.technicalDetails': match[1].toLowerCase() === 'show' } };
  if ((match = /^(?:turn|switch) (on|off) in-app notifications (globally|for this repository)$/i.exec(input))) return { operation: 'prepare', scope: match[2].toLowerCase() === 'globally' ? 'global' : 'repository', changes: { [notificationKey]: match[1].toLowerCase() === 'on' } };
  if (/^(?:show|manage|open) (?:in-app )?notification(?:s| settings)$/i.test(input)) return { operation: 'view' };
  if ((match = /^reset (global|repository) (?:in-app )?notifications(?: settings)?$/i.exec(input))) return { operation: 'reset', scope: match[1].toLowerCase() };
  if ((match = /^(?:use|switch to|set theme to) (system|light|dark)(?: mode| theme)?$/i.exec(input))) return { operation: 'prepare', changes: { 'appearance.theme': match[1].toLowerCase() } };
  if (/^follow (?:the )?system theme$/i.test(input)) return { operation: 'prepare', changes: { 'appearance.theme': 'system' } };
  if ((match = /^(?:use|set density to) (comfortable|compact)(?: density| spacing)?$/i.exec(input))) return { operation: 'prepare', changes: { 'appearance.density': match[1].toLowerCase() } };
  if ((match = /^(?:set|change) text (?:size|scale) to (\d{3}(?:\.\d{1,4})?)%$/i.exec(input)) && Number(match[1]) >= 100 && Number(match[1]) <= 200) return { operation: 'prepare', changes: { 'appearance.textScale': Number(match[1]) / 100 } };
  if (/^(?:reduce motion|use reduced motion)$/i.test(input)) return { operation: 'prepare', changes: { 'appearance.motion': 'reduced' } };
  if (/^follow (?:the )?system motion(?: preference)?$/i.test(input)) return { operation: 'prepare', changes: { 'appearance.motion': 'system' } };
  if (/^(?:reset|restore default) appearance(?: settings)?$/i.test(input)) return { operation: 'reset' };
  if (/^(?:apply|save) (?:this |the )?appearance change$/i.test(input)) return { operation: 'apply' };
  if (/^(?:cancel|discard) (?:this |the )?appearance change$/i.test(input)) return { operation: 'cancel' };
  return null;
}
