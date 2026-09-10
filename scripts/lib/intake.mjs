// Pure decision support. Probe evidence and authorization must come from live agent discovery.
export function intakeDecision(input = {}) {
  if (!input.target && input.intent !== 'create') return { action: 'ask', question: 'What is the target repository location, or do you want to create a new repository?' };
  if (input.intent === 'create' && !input.target && (!input.owner || !input.name)) return { action: 'ask', question: 'What name, purpose, owner, visibility and local destination should the new repository use?' };
  if (input.probe === 'exists') return input.identityVerified === true
    ? { action: 'adopt' } : { action: 'blocked', reason: 'Verify matching local and remote identity.' };
  if (input.probe !== 'confirmed-absent') return { action: 'blocked', reason: 'Repository absence is unverified; resolve access, authentication or network failure first.' };
  const missing = ['owner', 'name', 'purpose', 'destination'].filter(key => typeof input[key] !== 'string' || !input[key].trim());
  if (!['private', 'public', 'internal'].includes(input.visibility)) missing.push('visibility');
  if (input.intent !== 'create' || input.authorized !== true) missing.push('explicit creation authority');
  if (missing.length) return { action: 'ask', question: `Confirm ${missing.join(', ')} before repository creation.` };
  if (input.target && input.target !== `${input.owner}/${input.name}`) return { action: 'blocked', reason: 'Normalize and verify the target identity against owner/name before creation.' };
  return { action: 'create', repository: `${input.owner}/${input.name}`, visibility: input.visibility, destination: input.destination };
}
