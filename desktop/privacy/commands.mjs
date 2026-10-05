import { containsSecret } from '../connections/commands.mjs';

export const privacyShapes = Object.freeze({ view: [[], ['scope']], diagnostics: [[], []], chat: [['text'], []], prepare: [['changes'], ['scope', 'reset']],
  export: [['kind'], ['scope']], import: [[], ['scope']], delete: [['categories'], ['after']], apply: [[], ['hash']], cancel: [[], []],
  history: [[], ['before']], append: [['token', 'commandId', 'role', 'text'], []], draft: [['token', 'text'], []] });
export function privacyCommand(text) {
  if (typeof text !== 'string' || text.length > 2000 || containsSecret(text) || /["`<>\n\r]/.test(text)) return null;
  const input = text.trim().replace(/[.!?]$/, ''); let match;
  if (/^what (?:local )?data do you (?:keep|store)$|^show (?:the |my )?installation data(?: inventory)?$/i.test(input)) return { operation: 'view' };
  if (/^(?:show|inspect|manage) (?:privacy|local data|data inventory|data destinations)$/i.test(input)) return { operation: 'view' };
  if (/^(?:show|inspect) (?:redacted )?diagnostics$/i.test(input)) return { operation: 'diagnostics' };
  if (/^export (?:redacted )?diagnostics$/i.test(input)) return { operation: 'export', kind: 'diagnostics' };
  if ((match = /^(export|restore) (?:(?:this (?:project|repository)'?s)|(?:global)|(?:this (?:computer|mac)'?s)) settings$/i.exec(input))) {
    const scope = /global/i.test(input) ? 'global' : /computer|mac/i.test(input) ? 'host' : 'repository';
    return { operation: match[1].toLowerCase() === 'export' ? 'export' : 'import', ...(match[1].toLowerCase() === 'export' ? { kind: 'configuration' } : {}), scope };
  }
  if ((match = /^keep (?:completed )?(conversations|(?:verbose )?logs|(?:minimal )?audit) for (\d{1,5}) days(?: (globally|for this project))?$/i.exec(input))) {
    const category = /conversation/i.test(match[1]) ? 'conversation' : /log/i.test(match[1]) ? 'log' : 'audit';
    return { operation: 'prepare', changes: { ['privacy.' + category + 'Days']: Number(match[2]) }, ...(match[3] ? { scope: match[3].toLowerCase() === 'globally' ? 'global' : 'repository' } : {}) };
  }
  if ((match = /^delete (?:this (?:project|repository)'?s )?local (conversations|logs|audit records)$/i.exec(input))) return {
    operation: 'delete', categories: [match[1].toLowerCase() === 'conversations' ? 'conversation' : match[1].toLowerCase() === 'logs' ? 'log' : 'audit'] };
  if (/^(?:apply|save) (?:this |the )?privacy (?:change|export|restore|deletion)$/i.test(input)) return { operation: 'apply' };
  if (/^(?:cancel|discard) (?:this |the )?privacy (?:change|export|restore|deletion)$/i.test(input)) return { operation: 'cancel' };
  return null;
}
