import { containsSecret } from '../connections/commands.mjs';

export const deliveryKeys = Object.freeze(['delivery.keepLatest', 'delivery.warningGiB', 'delivery.capacityGiB']);
export const deliveryShapes = Object.freeze({ view: [[], ['scope']], chat: [['text'], []], scope: [['scope'], []], prepare: [['scope', 'changes'], []],
  reset: [['scope'], []], apply: [[], ['hash']], cancel: [[], []], inspect: [[], []], help: [['kind'], []],
  artifacts: [[], ['after']], artifact: [['action'], ['id']], artifactApply: [[], ['hash']] });
export function deliveryCommand(text) {
  if (typeof text !== 'string' || text.length > 2000 || containsSecret(text) || /["`<>\n\r]/.test(text)) return null;
  const input = text.trim().replace(/[.!?]$/, ''); let match;
  if (/^show (?:my |retained )?artifacts$/i.test(input)) return { operation: 'artifacts' };
  if ((match = /^(pin|unpin) (?:the |my )?latest artifact$/i.exec(input))) return { operation: 'artifact', action: match[1].toLowerCase(), id: 'latest' };
  if (/^make (?:the |my )?latest artifact (?:the |my )?recovery target$/i.test(input)) return { operation: 'artifact', action: 'recovery', id: 'latest' };
  if (/^clean up old artifacts$/i.test(input)) return { operation: 'artifact', action: 'retain' };
  if (/^(?:apply|save) (?:this |the )?artifact change$/i.test(input)) return { operation: 'artifactApply' };
  if (/^(?:show|manage|open) (?:delivery|delivery and artifacts)(?: settings)?$|^where is (?:the |my )?installer$/i.test(input)) return { operation: 'view' };
  if (/^check (?:this |my )?Mac (?:for builds|build prerequisites)$/i.test(input)) return { operation: 'inspect' };
  if ((match = /^keep (?:the )?latest (\d{1,3}) (?:verified )?artifacts (globally|for this repository)$/i.exec(input))) return { operation: 'prepare', scope: match[2].toLowerCase() === 'globally' ? 'global' : 'repository', changes: { 'delivery.keepLatest': Number(match[1]) } };
  if ((match = /^set artifact (warning|capacity) to (\d{1,6}) GiB$/i.exec(input))) return { operation: 'prepare', scope: 'host', changes: { ['delivery.' + (match[1].toLowerCase() === 'warning' ? 'warningGiB' : 'capacityGiB')]: Number(match[2]) } };
  if ((match = /^reset (host|global|repository) delivery settings$/i.exec(input))) return { operation: 'reset', scope: match[1].toLowerCase() };
  if (/^(?:apply|save) (?:this |the )?delivery change$/i.test(input)) return { operation: 'apply' };
  if (/^(?:cancel|discard) (?:this |the )?delivery (?:change|check)$/i.test(input)) return { operation: 'cancel' };
  if ((match = /^show (Mac build tools|Apple signing) setup$/i.exec(input))) return { operation: 'help', kind: match[1].toLowerCase() === 'apple signing' ? 'signing' : 'tools' };
  return null;
}
