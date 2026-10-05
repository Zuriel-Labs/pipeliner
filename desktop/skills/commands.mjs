import { containsSecret } from '../connections/commands.mjs';

export const skillShapes = Object.freeze({ view: [[], ['scope']], discover: [[], ['source', 'link', 'name']], choose: [['name'], []],
  prepare: [['action', 'name'], []], permission: [['scope', 'enabled'], []], apply: [[], ['hash']], cancel: [[], []], reset: [[], []], chat: [['text'], []] });

export function skillChatSafe(text) {
  if (typeof text !== 'string' || text.length > 4096) return false;
  if (!containsSecret(text)) return true;
  // Only a typed public content pin is exempt from the general long-token heuristic.
  const match = /^(?:add|inspect|update) skill from https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/tree\/([a-f0-9]{40})\/[A-Za-z0-9_./-]+$/i.exec(text.trim());
  return Boolean(match && !containsSecret(text.replace(match[1], 'pinned')));
}

// Explicit phrases bind the PM-selected scope. Quoted package prose is never a command.
export function skillCommand(text) {
  if (!skillChatSafe(text)) return null;
  const value = text.trim().replace(/[.!?]$/, ''); let match;
  if ((match = /^(?:show|inspect|manage) (?:(global|repository) )?(?:skills|skills and tools)$/i.exec(value))) return { operation: 'view', ...(match[1] ? { scope: match[1].toLowerCase() } : {}) };
  if ((match = /^(enable|disable|remove) (?:skill )?([a-z0-9]+(?:-[a-z0-9]+)*)$/i.exec(value))) return { operation: 'prepare', action: match[1].toLowerCase(), name: match[2] };
  if ((match = /^(allow|deny) (host|repository) agent skill installs$/i.exec(value))) return { operation: 'permission', scope: match[2].toLowerCase(), enabled: match[1].toLowerCase() === 'allow' };
  if (/^authorize this skill source$/i.test(value)) return { operation: 'prepare', action: 'authorize', name: 'selected' };
  if ((match = /^choose (?:skill )?name ([a-z0-9]+(?:-[a-z0-9]+)*)$/i.exec(value))) return { operation: 'choose', name: match[1] };
  if ((match = /^(?:add|inspect|update) skill from (https:\/\/github\.com\/\S+)$/i.exec(value))) return { operation: 'discover', link: match[1] };
  if (/^(?:apply|install) (?:this |the )?skill(?: change| package)?$/i.test(value)) return { operation: 'apply' };
  if (/^(?:cancel|discard) (?:this |the )?skill(?: change| package)?$/i.test(value)) return { operation: 'cancel' };
  if (/^reset skills to inherit$/i.test(value)) return { operation: 'reset' };
  return null;
}
