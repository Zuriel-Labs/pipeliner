import { makeRequest } from '../github/transport.mjs';
import { skillPackage, skillSource } from './package.mjs';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const supported = path => path === 'SKILL.md' || path === 'README.md' || /^LICENSE(?:\.txt|\.md)?$/.test(path)
  || /^references\/[A-Za-z0-9_.-]+\.(?:md|txt)$/.test(path);
const publicRequest = (send, signal) => makeRequest(null, (url, options) => {
  const { Authorization: ignored, ...headers } = options.headers;
  return send(url, { ...options, headers });
}, signal);

export async function discoverSkillLink(link, options = {}) {
  let parsed, match;
  try {
    if (typeof link !== 'string' || link.length > 1024 || !/^https:\/\/github\.com\//.test(link)) throw new Error();
    parsed = new URL(link);
    match = /^\/([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)\/tree\/([A-Za-z0-9_.-]{1,96})\/(.+)$/.exec(parsed.pathname);
    if (parsed.origin !== 'https://github.com' || parsed.username || parsed.password || parsed.search || parsed.hash || !match) throw new Error();
    skillSource({ repository: match[1], commit: 'a'.repeat(40), path: match[3] });
  } catch { throw new Error('Skill link must point to a public GitHub skill folder.'); }
  const deadline = AbortSignal.timeout(90000), signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let commit = match[2];
  if (!sha(commit)) {
    try { const resolved = await publicRequest(options.send ?? fetch, signal)('GET', '/repos/' + match[1] + '/commits/' + encodeURIComponent(commit));
      if (!sha(resolved.sha)) throw new Error(); commit = resolved.sha;
    } catch (error) { if (/^http-\d{3}$|^cancelled$/.test(error.message)) throw error; throw new Error('Skill link version could not be resolved safely.'); }
  }
  return discoverSkill({ repository: match[1], commit, path: match[3] }, { ...options, signal });
}

// Public discovery never borrows a connection lease or account credential.
export async function discoverSkill(input, { send = fetch, signal, name, occupied } = {}) {
  try {
    const source = skillSource(input), deadline = AbortSignal.timeout(90000);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const request = publicRequest(send, combined);
    const base = '/repos/' + source.repository + '/git/';
    const commit = await request('GET', base + 'commits/' + source.commit);
    if (commit.sha !== source.commit || !sha(commit.tree?.sha)) throw new Error('Skill source commit could not be verified.');
    const tree = async id => {
      const value = await request('GET', base + 'trees/' + id);
      if (value.sha !== id || value.truncated !== false || !Array.isArray(value.tree) || value.tree.length > 1000
        || value.tree.some(entry => typeof entry.path !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(entry.path)
          || ['.', '..'].includes(entry.path) || !sha(entry.sha)) || new Set(value.tree.map(entry => entry.path)).size !== value.tree.length)
        throw new Error('Skill source tree could not be verified.');
      return value.tree;
    };
    let id = commit.tree.sha;
    for (const segment of source.path.split('/')) {
      const entry = (await tree(id)).find(item => item.path === segment);
      if (entry?.mode !== '040000' || entry.type !== 'tree') throw new Error('Skill source folder unavailable.');
      id = entry.sha;
    }
    const entries = [];
    for (const entry of await tree(id)) {
      if (entry.path === 'references' && entry.mode === '040000' && entry.type === 'tree') {
        for (const child of await tree(entry.sha)) entries.push({ ...child, path: 'references/' + child.path });
      } else entries.push(entry);
    }
    if (!entries.length || entries.length > 32 || entries.some(entry => entry.mode !== '100644' || entry.type !== 'blob'
      || !supported(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > 131072)
      || entries.reduce((sum, entry) => sum + entry.size, 0) > 524288) throw new Error('Skill package has unsafe, unsupported or oversized content.');
    const files = [];
    for (const entry of entries) {
      const blob = await request('GET', base + 'blobs/' + entry.sha);
      if (blob.sha !== entry.sha || blob.encoding !== 'base64' || blob.size !== entry.size || typeof blob.content !== 'string'
        || !/^[A-Za-z0-9+/=\r\n]+$/.test(blob.content)) throw new Error('Skill source blob could not be verified.');
      const encoded = blob.content.replace(/[\r\n]/g, ''), body = Buffer.from(encoded, 'base64');
      if (body.toString('base64') !== encoded || body.length !== entry.size) throw new Error('Skill source content integrity failed.');
      const content = new TextDecoder('utf-8', { fatal: true }).decode(body);
      files.push({ path: entry.path, mode: entry.mode, sha: entry.sha, content });
    }
    return skillPackage({ source, files }, { ...(name ? { name } : {}), ...(occupied ? { occupied } : {}) });
  } catch (error) {
    if (/^Skill |^http-\d{3}$|^cancelled$/.test(error?.message)) throw error;
    throw new Error('Skill source could not be read safely.');
  }
}
