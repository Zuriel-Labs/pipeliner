import { parentPort, workerData } from 'node:worker_threads';
import Ajv2020 from 'ajv/dist/2020.js';
import AjvDraft7 from 'ajv';

try {
  const declared = workerData.schema?.$schema;
  if (declared !== undefined && !['https://json-schema.org/draft/2020-12/schema', 'http://json-schema.org/draft-07/schema#'].includes(declared)) throw new Error();
  const Validator = declared === 'http://json-schema.org/draft-07/schema#' ? AjvDraft7 : Ajv2020;
  const validator = new Validator({ strict: true, allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false, validateFormats: true, logger: false });
  validator.addKeyword({ keyword: 'x-mcp-header', schemaType: 'string' });
  const validate = validator.compile(workerData.schema);
  parentPort.postMessage({ ok: true, valid: Object.hasOwn(workerData, 'input') ? validate(workerData.input) : true });
} catch { parentPort.postMessage({ ok: false }); }
