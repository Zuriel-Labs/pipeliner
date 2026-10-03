import { canonicalJSON, validateExtension } from '../core/settings.mjs';
import { sourceSecretPattern } from '../development/source.mjs';
import { checkedJSON } from './schema.mjs';

export function validateToolBinding(extension, pack) {
  validateExtension(extension); const categories = pack.definition.dataCategories;
  if (pack.id !== undefined && (pack.id !== extension.pin || pack.kind !== extension.kind)) throw new Error('Tool binding does not match its selected pin.');
  if (Object.keys(extension.constants).length && !categories.includes('pm.supplied')) throw new Error('Tool data category was not approved for supplied values.');
  if (extension.bindings.some(binding => !categories.includes(binding.source))) throw new Error('Tool data category was not approved for this destination.');
}

// Only the captured host step chooses source fields. Tool text/output cannot add bindings or choose another repository.
export function boundToolInput(extension, pack, { issue, candidate, records }) {
  validateToolBinding(extension, pack); const input = structuredClone(extension.constants);
  for (const binding of extension.bindings) {
    let value;
    if (binding.source.startsWith('issue.')) value = issue[binding.source.slice(6)];
    else if (binding.source.startsWith('candidate.')) value = candidate[binding.source.slice(10)];
    else {
      const record = records.filter(row => row.step === binding.step && row.kind === 'extension' && row.state === 'verified'
        && canonicalJSON(row.result.candidate) === canonicalJSON(candidate)).at(-1);
      value = record?.result.result.structuredContent;
      for (const key of binding.selection ?? []) { if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) { value = undefined; break; } value = value[key]; }
    }
    if (value === undefined) throw new Error('Tool binding needs verified source data for its declared field.');
    let parent = input;
    for (const key of binding.path.slice(0, -1)) parent = parent[key] ??= {};
    parent[binding.path.at(-1)] = structuredClone(value);
  }
  checkedJSON(input, 'data'); if (sourceSecretPattern.test(canonicalJSON(input))) throw new Error('Tool sensitive input withheld.'); return input;
}
