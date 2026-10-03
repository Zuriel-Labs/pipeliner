import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { canonicalJSON, immutable, record } from '../core/settings.mjs';
import { containsSecret } from '../connections/commands.mjs';

export const skillName = value => typeof value === 'string' && value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
  && !['constructor', 'prototype'].includes(value);
const relative = value => typeof value === 'string' && value.length <= 240 && value.split('/').every(part =>
  part !== '.' && part !== '..' && /^[A-Za-z0-9_.-]+$/.test(part));
const text = (value, max) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max && !value.includes('\0')
  && Buffer.from(value, 'utf8').toString('utf8') === value;
const digest = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');

export function skillSource(source) {
  record(source, ['repository', 'commit', 'path']);
  const { repository, commit, path } = source;
  if (typeof repository !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repository)
    || ['.', '..'].includes(repository.split('/')[1]) || typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)
    || !relative(path) || path.split('/').length > 12) throw new Error('Skill source must use an exact repository, commit and package path.');
  return immutable({ repository, commit, path });
}

export function collisionChoices(name, occupied = []) {
  if (!skillName(name) || !Array.isArray(occupied) || occupied.length > 1000 || !occupied.every(skillName)) throw new Error('Skill name unavailable.');
  const candidates = /motif|design|shape|ui|visual|art/.test(name) ? ['palette', 'canvas', 'sketch', 'hue', 'lumen', 'vista', 'prism']
    : /forge|code|build|develop/.test(name) ? ['craft', 'smith', 'workshop', 'maker', 'engine', 'anvil']
      : /lens|review|audit|access/.test(name) ? ['insight', 'survey', 'clarity', 'focus', 'inspect', 'scout']
        : ['guide', 'method', 'beacon', 'compass', 'path', 'flow'];
  return candidates.filter(value => value !== name && !occupied.includes(value)).slice(0, 3);
}

// Package metadata is data, including allowed-tools. Only protected PM policy grants permissions.
export function skillPackage(input, options = {}) {
  try {
    canonicalJSON(input); canonicalJSON(options); record(input, ['source', 'files']); record(options, [], ['occupied', 'name']);
    const { commit, path } = skillSource(input.source);
    if (!Array.isArray(input.files) || !input.files.length || input.files.length > 32) throw new Error('Skill package file limit exceeded.');
    let bytes = 0; const names = new Set();
    const files = input.files.map(file => {
      record(file, ['path', 'content'], ['mode', 'sha']);
      if (!relative(file.path) || names.has(file.path) || file.mode !== undefined && file.mode !== '100644'
        || !text(file.content, 131072) || containsSecret(file.content)
        || !(file.path === 'SKILL.md' || file.path === 'README.md' || /^LICENSE(?:\.txt|\.md)?$/.test(file.path) || /^references\/[A-Za-z0-9_.-]+\.(?:md|txt)$/.test(file.path)))
        throw new Error('Skill package has an unsafe or unsupported file.');
      names.add(file.path); bytes += Buffer.byteLength(file.content);
      if (file.sha !== undefined) {
        const body = Buffer.from(file.content), sha = createHash('sha1').update('blob ' + body.length + '\0').update(body).digest('hex');
        if (file.sha !== sha) throw new Error('Skill source content integrity failed.');
      }
      return { path: file.path, content: file.content };
    }).sort((a, b) => a.path.localeCompare(b.path));
    if (bytes > 524288) throw new Error('Skill package size limit exceeded.');
    const entry = files.find(file => file.path === 'SKILL.md');
    const match = entry && /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(entry.content);
    if (!match || Buffer.byteLength(match[1]) > 8192) throw new Error('Skill frontmatter is missing or too large.');
    const doc = parseDocument(match[1], { schema: 'failsafe', strict: true, uniqueKeys: true, stringKeys: true, prettyErrors: false, logLevel: 'silent' });
    if (doc.errors.length || doc.warnings.length) throw new Error('Skill frontmatter could not be verified.');
    const metadata = doc.toJS({ maxAliasCount: 0 }); canonicalJSON(metadata);
    record(metadata, ['name', 'description'], ['license', 'compatibility', 'metadata', 'allowed-tools']);
    if (!skillName(metadata.name) || path.split('/').at(-1) !== metadata.name) throw new Error('Skill name must match its source package folder.');
    if (!text(metadata.description, 1024) || !text(metadata.license, 240) || /[\r\n]/.test(metadata.license)) throw new Error('Skill description or license unavailable.');
    if (!files.some(file => /^LICENSE(?:\.txt|\.md)?$/.test(file.path))) throw new Error('Skill license text unavailable.');
    if (metadata.compatibility !== undefined && !text(metadata.compatibility, 500)) throw new Error('Skill compatibility declaration invalid.');
    if (metadata.metadata !== undefined && (!metadata.metadata || typeof metadata.metadata !== 'object' || Array.isArray(metadata.metadata)
      || Object.keys(metadata.metadata).some(key => ['__proto__', 'constructor', 'prototype'].includes(key))
      || Object.values(metadata.metadata).some(value => typeof value !== 'string'))) throw new Error('Skill version metadata invalid.');
    const version = metadata.metadata?.version ?? 'commit-' + commit;
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/.test(version)) throw new Error('Skill version unavailable.');
    if (metadata['allowed-tools'] !== undefined && !text(metadata['allowed-tools'], 1024)) throw new Error('Skill tool requirements invalid.');
    const instructions = match[2].trim(); if (!text(instructions, 65536)) throw new Error('Skill instructions unavailable or too large.');
    const occupied = options.occupied ?? [], name = options.name ?? metadata.name;
    if (!Array.isArray(occupied) || occupied.length > 1000 || !occupied.every(skillName) || !skillName(name)) throw new Error('Skill selected name invalid.');
    if (occupied.includes(name)) throw new Error('Skill name collision. Choose an available name.');
    return immutable({ name, originalName: metadata.name, purpose: metadata.description.trim(), trigger: metadata.description.trim(), version,
      source: skillSource(input.source), license: metadata.license, compatibility: metadata.compatibility ?? null,
      permissions: [], requirements: [...new Set(metadata['allowed-tools']?.trim().split(/\s+/) ?? [])],
      instructions, files, digest: digest({ source: input.source, files }) });
  } catch (error) {
    if (/^Skill /.test(error.message)) throw error;
    // No raw YAML, package text, URL or secret is included in public diagnostics.
    throw new Error('Skill package metadata could not be verified.');
  }
}
