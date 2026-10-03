import { createHash } from 'node:crypto';
import { canonicalJSON, immutable, record, extensionInputNames } from '../core/settings.mjs';
import { containsSecret } from '../connections/commands.mjs';
import { sourceSecretPattern } from '../development/source.mjs';
import { skillName } from '../skills/package.mjs';
import { endpointURL, protocolVersion } from './transport.mjs';
import { checkSchema, checkedJSON, headerParameters } from './schema.mjs';

export const toolManifestHash = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');
const text = (value, maximum) => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\p{Cc}\p{Cf}]/u.test(value) && !containsSecret(value);
export const toolDataCategories = extensionInputNames;

// A definition declares requested access. It never grants that access or identifies the caller as a PM.
export function toolPackage(definition, { name = definition?.name } = {}) {
  try {
    checkedJSON(definition, 'tool'); record(definition, ['name', 'purpose', 'version', 'license', 'dataCategories'], ['mcp', 'command']);
    if (!skillName(name) || !skillName(definition.name) || !text(definition.purpose, 1024) || !text(definition.license, 240)
      || typeof definition.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/.test(definition.version)
      || !Array.isArray(definition.dataCategories) || definition.dataCategories.length > toolDataCategories.length
      || new Set(definition.dataCategories).size !== definition.dataCategories.length || definition.dataCategories.some(value => !toolDataCategories.includes(value))
      || Object.hasOwn(definition, 'mcp') === Object.hasOwn(definition, 'command') || sourceSecretPattern.test(canonicalJSON(definition))) throw new Error();
    const kind = definition.mcp ? 'mcp' : 'command'; let sourceIdentity, permissions;
    if (kind === 'mcp') {
      const mcp = definition.mcp; record(mcp, ['endpoint', 'protocolVersion', 'tool']); endpointURL(mcp.endpoint);
      const tool = mcp.tool; record(tool, ['name', 'inputSchema'], ['title', 'description', 'outputSchema', 'annotations', 'icons', '_meta']);
      if (mcp.protocolVersion !== protocolVersion || typeof tool.name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name)
        || !tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema)) throw new Error();
      headerParameters(tool.inputSchema, {}); if (tool.outputSchema !== undefined) headerParameters(tool.outputSchema, {});
      sourceIdentity = { kind: 'mcp-endpoint-catalog', endpoint: mcp.endpoint, protocolVersion, tool: tool.name, catalogDigest: toolManifestHash(tool) };
      permissions = ['extension.invoke'];
    } else {
      const command = definition.command; record(command, ['script', 'timeoutSeconds', 'inputSchema']);
      if (typeof command.script !== 'string' || !command.script.trim() || Buffer.byteLength(command.script) > 4096 || command.script.includes('\0')
        || !Number.isSafeInteger(command.timeoutSeconds) || command.timeoutSeconds < 1 || command.timeoutSeconds > 300
        || !command.inputSchema || typeof command.inputSchema !== 'object' || Array.isArray(command.inputSchema)) throw new Error();
      headerParameters(command.inputSchema, {});
      sourceIdentity = { kind: 'pm-command-definition', definitionDigest: toolManifestHash(command) };
      permissions = ['extension.invoke', 'worker.exec', 'workspace.write'];
    }
    return immutable({ name, originalName: definition.name, kind, purpose: definition.purpose, version: definition.version, license: definition.license,
      sourceIdentity, permissions, definition: structuredClone(definition), digest: toolManifestHash(definition) });
  } catch { throw new Error('Tool definition is unsupported or unsafe. No permissions were granted.'); }
}

export async function qualifyToolPackage(pack, { signal } = {}) {
  if (canonicalJSON(toolPackage(pack.definition, { name: pack.name })) !== canonicalJSON(pack)) throw new Error('Tool package must be verified before qualification.');
  const tool = pack.definition.mcp?.tool ?? pack.definition.command;
  await checkSchema(tool.inputSchema, undefined, { signal }); if (tool.outputSchema !== undefined) await checkSchema(tool.outputSchema, undefined, { signal });
  return true;
}
