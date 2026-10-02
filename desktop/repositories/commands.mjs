import { containsSecret } from '../connections/commands.mjs';

export function setupCommand(text) {
  if (typeof text !== 'string' || text.length > 2000 || containsSecret(text)) return null;
  const value = text.trim().replace(/[.!?]$/, '');
  let match;
  if (/^(?:please )?(?:import|connect|use) (?:a |my |an |the )?(?:existing |local |github )?(?:project|repository)$/i.test(value)) return { operation: 'begin', mode: /local/i.test(value) ? 'local' : 'import', values: {} };
  if ((match = /^(?:please )?import (?:https:\/\/github\.com\/)?([a-z0-9-]{1,39}\/[a-z0-9_.-]{1,100})(?:\.git)?$/i.exec(value))) return { operation: 'begin', mode: 'import', values: { repository: match[1].replace(/\.git$/, '') } };
  if ((match = /^(?:please )?create (?:a |my |an )?(?:(private|public) )?(?:project|repository)(?: (?:called|named) ([a-z0-9_.-]{1,100}))?(?: for (.{1,350}))?$/i.exec(value))) return { operation: 'begin', mode: 'create', values: { ...(match[1] ? { visibility: match[1].toLowerCase() } : {}), ...(match[2] ? { name: match[2] } : {}), ...(match[3] ? { purpose: match[3] } : {}) } };
  if (/^(?:apply|finish|confirm) (?:this |the )?setup$/i.test(value)) return { operation: 'apply' };
  if (/^(?:review|preview|check) (?:this |the )?setup$/i.test(value)) return { operation: 'prepare' };
  if (/^cancel (?:this |the )?setup$/i.test(value)) return { operation: 'cancel' };
  if (/^(?:check|repair|continue) (?:this |the )?setup$/i.test(value)) return { operation: 'repair' };
  if (/^(?:choose|select|change) (?:a |the )?(?:local )?folder$/i.test(value)) return { operation: 'folder' };
  if (/^(?:create|use) (?:a |the )?new (?:private )?project$/i.test(value)) return { operation: 'choose', field: 'project', value: 'new' };
  if ((match = /^(?:make|keep) (?:it|the repository|the project) (private|public)$/i.exec(value))) return { operation: 'choose', field: 'visibility', value: match[1].toLowerCase() };
  if ((match = /^(?:name|call) (?:it|the repository|the project) ([a-z0-9_.-]{1,100})$/i.exec(value))) return { operation: 'choose', field: 'name', value: match[1] };
  if ((match = /^use ([a-z0-9-]{1,39}) (?:as (?:the )?owner|for (?:the )?owner)$/i.exec(value))) return { operation: 'choose', field: 'owner', value: match[1] };
  if ((match = /^use (.{1,256}) for (status|priority|impact|effort)$/i.exec(value))) return { operation: 'map', role: match[2].toLowerCase(), name: match[1] };
  if ((match = /^(?:use|select) project (.{1,256})$/i.exec(value))) return { operation: 'choose', field: 'projectName', value: match[1] };
  return null;
}
