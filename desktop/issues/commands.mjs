import { containsSecret } from '../connections/commands.mjs';

// ponytail: finite guided phrases; qualified model-assisted authoring joins this host path in D-14.
export function issueCommand(text) {
  if (typeof text !== 'string' || text.length > 4096 || containsSecret(text)) return null;
  const value = text.trim().replace(/[.!?]$/, ''); let match;
  if (/^(?:please )?(?:show|list|refresh|check) (?:my |the )?issues$/i.test(value)) return { operation: 'refresh' };
  if ((match = /^(?:please )?(?:draft|prepare|write) (?:a |an |the )?issue(?: (?:called|named) (.{1,256}))?$/i.exec(value))) return { operation: 'begin', values: match[1] ? { title: match[1] } : {} };
  if ((match = /^(?:show|select|open) (?:issue )?#?(\d+)$/i.exec(value))) return { operation: 'select', number: Number(match[1]) };
  if ((match = /^(?:mark|make) (?:issue )?#?(\d+) ready$/i.exec(value))) return { operation: 'ready', number: Number(match[1]), enabled: true };
  if ((match = /^(add|remove) ready (?:to|from) (?:issue )?#?(\d+)$/i.exec(value))) return { operation: 'ready', number: Number(match[2]), enabled: match[1].toLowerCase() === 'add' };
  if (/^(?:review|preview|check) (?:this |the )?issue(?: draft)?$/i.test(value)) return { operation: 'prepare' };
  if (/^create (?:this |the )?issue$/i.test(value)) return { operation: 'create' };
  if (/^cancel (?:this |the )?issue draft$/i.test(value)) return { operation: 'cancel' };
  if (/^(?:continue|check|repair) (?:this |the )?issue setup$/i.test(value)) return { operation: 'repair' };
  if ((match = /^set (priority|impact|effort) (?:to )?(.{1,10})$/i.exec(value))) return { operation: 'choose', field: match[1].toLowerCase(), value: match[2] };
  if ((match = /^(?:name|call) (?:the |this )?issue (.{1,256})$/i.exec(value))) return { operation: 'choose', field: 'title', value: match[1] };
  if ((match = /^set (?:the )?issue outcome (?:to )?(.{1,4000})$/i.exec(value))) return { operation: 'choose', field: 'summary', value: match[1] };
  if ((match = /^set (?:issue )?labels (?:to )?(.{1,2000})$/i.exec(value))) return { operation: 'choose', field: 'labels', value: match[1].split(',').map(label => label.trim()) };
  if ((match = /^(?:this issue )?depends on (?:issue )?#?(\d+)((?:\s*(?:,|and)\s*(?:issue )?#?\d+)*)$/i.exec(value))) return { operation: 'choose', field: 'dependencies', value: [...(match[1] + match[2]).matchAll(/\d+/g)].map(item => Number(item[0])) };
  if ((match = /^use (pm|coauthored|agent) issue authoring$/i.exec(value))) return { operation: 'policy-prepare', mode: match[1].toLowerCase() };
  if ((match = /^(allow|enable|disable|deny) agent issue creation$/i.exec(value))) return { operation: 'policy-prepare', agentCreation: ['allow', 'enable'].includes(match[1].toLowerCase()) };
  if (/^apply (?:this |the )?issue authoring (?:policy|change)$/i.test(value)) return { operation: 'policy-apply' };
  if (/^cancel (?:this |the )?issue authoring (?:policy|change)$/i.test(value)) return { operation: 'policy-cancel' };
  return null;
}
