import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
// Freshness and coverage of an agent's semantic review; not a shell safety proof.
export async function auditCI(root, supplied) {
  const errors = [];
  let workflows;
  try { workflows = (await readdir(path.join(root, '.github/workflows'))).filter(name => /\.ya?ml$/.test(name)); }
  catch (error) { return error.code === 'ENOENT' ? [] : [error.message]; }
  if (!workflows.length) return [];
  let review = supplied;
  if (!review) {
    try { review = JSON.parse(await readFile(path.join(root, '.agents/ci-review.json'), 'utf8')); }
    catch { return ['CI requires .agents/ci-review.json with reviewed workflow and transitive command hashes; do not execute unreviewed workflows.']; }
  }
  if (review?.version !== 1 || !review.workflows || typeof review.workflows !== 'object') return ['invalid CI review ledger'];
  const canonicalRoot = await realpath(root);
  for (const name of workflows) {
    const relative = `.github/workflows/${name}`;
    const entry = review.workflows[relative];
    if (!entry || typeof entry.rationale !== 'string' || !entry.rationale.trim() || !entry.files?.[relative]) {
      errors.push(`CI review missing for ${relative}`); continue;
    }
    for (const [file, hash] of Object.entries(entry.files)) {
      if (!file || path.isAbsolute(file) || file.split(/[\\/]/).includes('..') || file.includes('\\') || !/^[a-f0-9]{64}$/.test(hash)) {
        errors.push(`unsafe CI review path or digest: ${file}`); continue;
      }
      try {
        const full = path.join(root, file);
        const resolved = await realpath(full);
        if ((await lstat(full)).isSymbolicLink() || !resolved.startsWith(canonicalRoot + path.sep)) throw new Error('unsafe symlink');
        if (digest(await readFile(full)) !== hash) errors.push(`CI review stale: ${file}`);
      } catch (error) { errors.push(`CI review unreadable: ${file}: ${error.message}`); }
    }
  }
  return errors;
}
