import { canonicalJSON, record } from '../core/settings.mjs';
import { sourceSecretPattern } from '../development/source.mjs';
import { checkSchema, checkedJSON } from './schema.mjs';
import { toolPackage, qualifyToolPackage, toolManifestHash } from './package.mjs';

const safeErrors = new Set(['Tool authority unavailable.', 'Tool run binding unavailable.', 'Tool content integrity failed.',
  'Tool input does not match its captured schema.', 'Tool connection needs qualification.', 'Tool destination changed.',
  'Tool catalog changed. Review a new exact definition before execution.', 'Tool server returned an error; effect needs readback.',
  'Tool restricted worker unavailable.', 'Tool restricted command denied or incomplete.', 'Tool command result withheld.',
  'Tool command result incomplete; worker and candidate need readback.']);

function authority(authorize, signal) {
  signal?.throwIfAborted(); if (typeof authorize !== 'function') throw new Error('Tool authority unavailable.');
  const result = authorize(); if (result instanceof Promise) { result.catch(() => {}); throw new Error('Tool authority unavailable.'); }
  if (result === false) throw new Error('Tool authority unavailable.');
}

export async function verifyMCPCatalog(pack, client, { signal, authorize }) {
  authority(authorize, signal);
  if (client.endpoint !== pack.definition.mcp.endpoint || client.protocolVersion !== pack.definition.mcp.protocolVersion) throw new Error('Tool destination changed.');
  const catalog = await client.list({ signal }); authority(authorize, signal);
  const current = catalog.tools.find(value => value.name === pack.definition.mcp.tool.name);
  if (!current || toolManifestHash(current) !== pack.sourceIdentity.catalogDigest) throw new Error('Tool catalog changed. Review a new exact definition before execution.');
}

// Host-only execution. The caller records durable intent before this function and fences the captured run/owner/epoch.
export async function invokePinnedTool({ pack, binding, input, supervisor, connectMCP, authorize, signal }) {
  let client, dispatched = false;
  const fence = () => authority(authorize, signal);
  try {
    fence(); record(binding, ['runId', 'epoch']);
    if (typeof binding.runId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(binding.runId) || !Number.isSafeInteger(binding.epoch) || binding.epoch < 1) throw new Error('Tool run binding unavailable.');
    const { id: _pin, ...document } = pack;
    if (canonicalJSON(toolPackage(pack.definition, { name: pack.name })) !== canonicalJSON(document)) throw new Error('Tool content integrity failed.');
    await qualifyToolPackage(document, { signal }); fence(); checkedJSON(input, 'data');
    const definition = pack.definition.mcp?.tool ?? pack.definition.command;
    if (!input || typeof input !== 'object' || Array.isArray(input) || sourceSecretPattern.test(canonicalJSON(input))
      || !await checkSchema(definition.inputSchema, input, { signal })) throw new Error('Tool input does not match its captured schema.');
    fence(); let result;
    if (pack.kind === 'mcp') {
      if (!connectMCP) throw new Error('Tool connection needs qualification.');
      client = await connectMCP(pack, { binding, signal, authorize: fence }); fence();
      await verifyMCPCatalog(pack, client, { signal, authorize: fence });
      // No annotations, read-only hints or result text establish replay authority.
      dispatched = true;
      try { result = await client.call(definition, input, { signal }); }
      catch (error) { if (error.dispatched === false) dispatched = false; throw error; }
      fence(); if (result.isError === true) throw new Error('Tool server returned an error; effect needs readback.');
    } else {
      if (!supervisor?.tool) throw new Error('Tool restricted worker unavailable.');
      dispatched = true;
      const response = await supervisor.tool(binding, { operation: 'run', command: definition.script, timeoutMs: definition.timeoutSeconds * 1000, input }, { signal });
      fence(); if (response?.ok !== true) throw new Error('Tool restricted command denied or incomplete.');
      const value = response.result; record(value, ['exitCode', 'output', 'truncated', 'timedOut']);
      if (!Number.isSafeInteger(value.exitCode) || typeof value.output !== 'string' || Buffer.byteLength(value.output) > 65536
        || typeof value.truncated !== 'boolean' || typeof value.timedOut !== 'boolean' || sourceSecretPattern.test(value.output)) throw new Error('Tool command result withheld.');
      if (value.truncated || value.timedOut) throw new Error('Tool command result incomplete; worker and candidate need readback.');
      result = { structuredContent: value, content: [{ type: 'text', text: value.output }], isError: value.exitCode !== 0 };
    }
    fence(); checkedJSON(result, 'result', 524288); if (sourceSecretPattern.test(canonicalJSON(result))) throw new Error('Tool command result withheld.');
    return { ...result, sourceDigest: pack.digest };
  } catch (error) {
    const message = safeErrors.has(error?.message) ? error.message : signal?.aborted ? 'Tool execution interrupted; effect needs readback.' : 'Tool execution failed; inspect its recorded outcome.';
    throw Object.assign(new Error(message), { dispatched });
  } finally {
    try { await client?.close(); }
    catch { throw Object.assign(new Error('Tool cleanup could not be verified; effect needs readback.'), { dispatched }); }
  }
}
