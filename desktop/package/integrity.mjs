import { createHash } from 'node:crypto';

// Electron 41+ arm64 framework contract; reject other slot schemas instead of failing open.
export function embedIntegrityDigest(bytes, headerHash) {
  if(!Buffer.isBuffer(bytes)||typeof headerHash!=='string'||!/^[a-f0-9]{64}$/.test(headerHash))throw new Error('package-integrity-invalid');
  const sentinel=Buffer.from('AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A'),offset=bytes.indexOf(sentinel);
  if(offset<0||bytes.indexOf(sentinel,offset+sentinel.length)!==-1)throw new Error('package-integrity-slot-invalid');
  const slot=offset+sentinel.length;
  if(slot+34>bytes.length||![0,1].includes(bytes[slot])||![0,1].includes(bytes[slot+1]))throw new Error('package-integrity-schema-invalid');
  const output=Buffer.from(bytes),digest=createHash('sha256').update('Resources/app.asar').update('SHA256').update(headerHash).digest();
  output[slot]=1;output[slot+1]=1;digest.copy(output,slot+2);return output;
}
