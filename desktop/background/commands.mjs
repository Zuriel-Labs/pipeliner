import { containsSecret } from '../connections/commands.mjs';
export const backgroundShapes = { chat: [['text'], []], view: [[], []], prepare: [['changes'], []], apply: [[], ['hash']], cancel: [[], []], cleanup: [[], []], authorize: [[], []] };
export function backgroundCommand(text) {
  if (typeof text !== 'string' || text.length > 2000 || containsSecret(text) || /["`<>\n\r]/.test(text)) return null;
  const input = text.trim().replace(/[.!?]$/, '');
  if (/^(show|inspect|check) (the )?background (operation|state|service)$/i.test(input)) return { operation: 'view' };
  if (/^enable background operation$/i.test(input)) return { operation: 'prepare', changes: { 'background.enabled': true } };
  if (/^disable background operation$/i.test(input)) return { operation: 'prepare', changes: { 'background.enabled': false, 'background.startAtLogin': false } };
  if (/^(start at login|enable start at login|disable start at login|do not start at login)$/i.test(input)) return { operation: 'prepare', changes: { 'background.startAtLogin': !/^(disable|do not)/i.test(input) } };
  if (/^apply (this |the )?background change$/i.test(input)) return { operation: 'apply' };
  if (/^cancel (this |the )?background change$/i.test(input)) return { operation: 'cancel' };
  if (/^retry background cleanup$/i.test(input)) return { operation: 'cleanup' };
  if (/^open background authorization$/i.test(input)) return { operation: 'authorize' };
  return null;
}
