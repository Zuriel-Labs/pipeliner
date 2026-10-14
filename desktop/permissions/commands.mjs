import { containsSecret } from '../connections/commands.mjs';

export const permissionLabels = Object.freeze({
  'workspace.read': 'Reading project files', 'workspace.write': 'Editing project files', 'worker.exec': 'Running project checks',
  'provider.turn': 'Sending model requests', 'git.push': 'Pushing project branches', 'github.read': 'Reading GitHub work',
  'github.issue.write': 'Updating GitHub Issues', 'github.pr.write': 'Updating pull requests', 'github.project.write': 'Updating Project cards',
  'extension.install': 'Installing approved extensions', 'extension.invoke': 'Using configured tools', 'artifact.build': 'Building applications',
  'artifact.publish': 'Publishing installers', 'host.launch': 'Launching test applications', 'host.install': 'Installing test applications', 'host.automation': 'Controlling test applications',
});
export const permissionKeys = Object.freeze(['permissions.ceiling', 'permissions.grants', 'permissions.resources']);
export const permissionShapes = Object.freeze({ view: [[], ['scope']], chat: [['text'], []], prepare: [['changes'], ['scope']],
  toggle: [['capability', 'enabled'], ['scope']], resource: [['reference', 'enabled'], ['scope']], reset: [[], ['scope']], revoke: [[], ['scope']], apply: [[], ['hash']], cancel: [[], []], repair: [[], []] });
export function permissionCommand(text) {
  if (typeof text !== 'string' || text.length > 2000 || containsSecret(text) || /["`<>\n\r]/.test(text)) return null;
  let input = text.trim().replace(/[.!?]$/, ''), scope;
  const suffix = / (on this (?:Mac|computer)|globally|for this (?:project|repository))$/i.exec(input);
  if (suffix) { scope = /^on /i.test(suffix[1]) ? 'host' : /^globally$/i.test(suffix[1]) ? 'global' : 'repository'; input = input.slice(0, suffix.index); }
  const selected = scope ? { scope } : {};
  if (/^(?:show|manage|open) (?:permissions|permissions and local testing)(?: settings)?$/i.test(input)) return { operation: 'view', ...selected };
  if (/^reset (host|global|repository) permissions$/i.test(input)) { const target = input.split(' ')[1].toLowerCase(); return scope && scope !== target ? null : { operation: 'reset', scope: target }; }
  if (/^revoke all permissions$/i.test(input)) return { operation: 'revoke', ...selected };
  if (/^(?:apply|save) (?:this |the )?permission change$/i.test(input) && !scope) return { operation: 'apply' };
  if (/^(?:cancel|discard) (?:this |the )?permission change$/i.test(input) && !scope) return { operation: 'cancel' };
  if (/^retry permission recovery$/i.test(input) && !scope) return { operation: 'repair' };
  const match = /^(allow|grant|revoke|deny) (.+)$/i.exec(input);
  const resource = /^(allow|grant|revoke|deny) qualified resource ([A-Za-z][A-Za-z0-9_-]{0,95})$/i.exec(input);
  if (resource) return { operation: 'resource', reference: resource[2], enabled: /^(allow|grant)$/i.test(resource[1]), ...selected };
  const capability = match && Object.keys(permissionLabels).find(key => permissionLabels[key].toLowerCase() === match[2].toLowerCase());
  return capability ? { operation: 'toggle', capability, enabled: /^(allow|grant)$/i.test(match[1]), ...selected } : null;
}
