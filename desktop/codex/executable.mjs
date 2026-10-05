import { isAbsolute, normalize, join } from 'node:path';

export function packagedCodexPath({ packaged = Boolean(process.versions.electron) && !process.defaultApp, resourcesPath = process.resourcesPath } = {}) {
  if(!packaged)return '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  if(typeof resourcesPath!=='string'||!isAbsolute(resourcesPath)||normalize(resourcesPath)!==resourcesPath||resourcesPath.includes('\0'))throw new Error('package-provider-path-invalid');
  return join(resourcesPath,'helpers/codex');
}
