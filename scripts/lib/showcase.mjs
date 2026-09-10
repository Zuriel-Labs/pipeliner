export const identityMatches = (keys, a, b) => keys.every(key => typeof a?.[key] === 'string' && a[key].trim() && a[key] === b?.[key]);
export const nonempty = value => typeof value === 'string' && value.trim().length > 0;
export const renderApproval = (phrase, issue) => phrase.replaceAll('{number}', String(issue));
const texts = (items, minimum = 0) => Array.isArray(items) && items.length >= minimum && items.every(nonempty);

export function showcaseComplete(showcase, keys, candidate, phrase, { scope = 'issue', issue } = {}) {
  if (!showcase || showcase.scope !== scope || !Number.isSafeInteger(showcase.issue) || showcase.issue < 1 || (issue !== undefined && showcase.issue !== issue)) return false;
  if (!identityMatches(keys, candidate, showcase.candidate) || showcase.approvalPhrase !== phrase) return false;
  if (!['summary', 'target', 'nextOutcome'].every(key => nonempty(showcase[key]))) return false;
  if (!['prerequisites', 'limitations'].every(key => texts(showcase[key])) || !texts(showcase.testResults, 1) || !texts(showcase.regressions, 1)) return false;
  if (!Array.isArray(showcase.findings) || !showcase.findings.every(f => nonempty(f?.problem) && nonempty(f?.remediation) && nonempty(f?.evidence))) return false;
  return Array.isArray(showcase.steps) && showcase.steps.length > 0 && showcase.steps.every(step => nonempty(step?.action) && nonempty(step?.expected));
}
