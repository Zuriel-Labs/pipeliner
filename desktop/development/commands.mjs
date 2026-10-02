export const developmentShapes = Object.freeze({ chat: [['text'], []], 'dev-prepare': [['dev'], []], 'permissions-prepare': [['scope'], []],
  apply: [['hash'], []], cancel: [[], []], start: [[], ['number']], pause: [[], []], resume: [[], []], stop: [[], []] });
export function developmentCommand(text) {
  if (typeof text !== 'string' || text.length > 2000 || /^[\s"'`>]/.test(text) || /[\n\r]/.test(text)) return null;
  const value = text.trim().replace(/[.!?]$/, '');
  let match;
  if ((match = /^(?:start|work on) (?:Issue )?#?(\d+)$/i.exec(value))) return { operation: 'start', number: Number(match[1]) };
  if (/^(?:start development|start this Issue|work on this Issue)$/i.test(value)) return { operation: 'start' };
  if (/^(?:pause|pause development|pause this Issue)$/i.test(value)) return { operation: 'pause' };
  if (/^(?:stop|stop development|stop this Issue)$/i.test(value)) return { operation: 'stop' };
  if (/^(?:resume|resume development|resume this Issue)$/i.test(value)) return { operation: 'resume' };
  if ((match = /^use (ollama|codex) (?:as (?:the )?Dev|for development)$/i.exec(value))) return { operation: 'choose-provider', provider: match[1].toLowerCase() };
  if (/^(?:show development|development status|choose a Dev|show agents and models)$/i.test(value)) return { operation: 'show' };
  if (/^review host development permissions$/i.test(value)) return { operation: 'permissions-prepare', scope: 'host' };
  if (/^review repository development permissions$/i.test(value)) return { operation: 'permissions-prepare', scope: 'repository' };
  if (/^apply this development change$/i.test(value)) return { operation: 'apply' };
  if (/^cancel this development change$/i.test(value)) return { operation: 'cancel' };
  return null;
}
