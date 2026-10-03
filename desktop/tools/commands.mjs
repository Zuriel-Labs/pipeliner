import { containsSecret } from '../connections/commands.mjs';
export const toolShapes = Object.freeze({ view: [[], ['scope']], discover: [['endpoint'], ['authentication']], select: [['tool'], []],
  define: [['definition'], []], rename: [['name'], []], prepare: [['action', 'name'], []], permission: [['scope', 'enabled'], []],
  credential: [['name', 'action'], []], apply: [[], ['hash']], cancel: [[], []], reset: [[], []], chat: [['text'], []] });

export function toolChatSafe(text) {
  if (typeof text !== 'string' || text.length > 4096) return false;
  // The literal UI choice is not credential material. Any actual bearer value remains denied.
  return !containsSecret(text.replace(/ with (?:a )?bearer credential[.!?]?$/i, ' with protected entry'));
}
export function toolCommand(text) {
  if (!toolChatSafe(text)) return null;
  const value = text.trim().replace(/[.!?]$/, ''); let match;
  if ((match = /^(?:show|inspect|manage) (?:(global|repository) )?(?:tools|tool servers|mcps)$/i.exec(value))) return { operation: 'view', ...(match[1] ? { scope: match[1].toLowerCase() } : {}) };
  if ((match = /^(?:add|inspect|update) (?:mcp|tool server) from (https:\/\/\S+?)(?: with (?:a )?bearer credential)?$/i.exec(value))) return { operation: 'discover', endpoint: match[1], authentication: / with (?:a )?bearer credential$/i.test(value) ? 'bearer' : 'none' };
  if ((match = /^choose tool ([A-Za-z0-9_.-]{1,128})$/i.exec(value))) return { operation: 'select', tool: match[1] };
  if ((match = /^choose tool name ([a-z0-9]+(?:-[a-z0-9]+)*)$/i.exec(value))) return { operation: 'rename', name: match[1] };
  if ((match = /^(enable|disable|remove) (?:tool|mcp) ([a-z0-9]+(?:-[a-z0-9]+)*)$/i.exec(value))) return { operation: 'prepare', action: match[1].toLowerCase(), name: match[2] };
  if ((match = /^(allow|deny) (host|repository) tool calls$/i.exec(value))) return { operation: 'permission', scope: match[2].toLowerCase(), enabled: match[1].toLowerCase() === 'allow' };
  if ((match = /^(connect|disconnect|replace) (?:tool|mcp) ([a-z0-9]+(?:-[a-z0-9]+)*) (?:credential|credentials)$/i.exec(value))) return { operation: 'credential', name: match[2], action: match[1].toLowerCase() === 'disconnect' ? 'disconnect' : 'connect' };
  if (/^authorize this tool source$/i.test(value)) return { operation: 'prepare', action: 'authorize', name: 'selected' };
  if (/^(?:apply|install) (?:this |the )?tool(?: change| definition)?$/i.test(value)) return { operation: 'apply' };
  if (/^(?:cancel|discard) (?:this |the )?tool(?: change| definition| discovery)?$/i.test(value)) return { operation: 'cancel' };
  if (/^reset tools to inherit$/i.test(value)) return { operation: 'reset' };
  return null;
}
