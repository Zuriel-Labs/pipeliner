// Bounded detection of known conflicting directives, not a prose safety proof.
export function validateQuestionText(text) {
  const errors = new Set();
  for (const clause of text.replace(/[`*]/g, '').split(/[.;\n]/)) {
    const native = /\b(?:use|using|prefer|call|invoke|through)\s+(?:(?:the|a|supported|permitted|available|built-in|desktop|app)\s+)*(?:request_user_input(?:_async)?|AskUserQuestion|native (?:app )?question(?:s| controls| tools)?|structured question (?:tools|controls)|(?:GPT|ChatGPT|Codex) (?:questions? )?feature)\b/gi;
    for (const match of clause.matchAll(native)) {
      const prefix = clause.slice(0, match.index);
      if (/\b(?:never|do not|don't|must not|should not|prohibit|prohibits|avoid)\s*$/i.test(prefix)) continue;
      if (/feature/i.test(match[0]) && !/question/i.test(clause)) continue;
      errors.add('superseded native-question directive; use message-only questions and end the turn');
    }
    if (/questions use native controls/i.test(clause)) errors.add('superseded native-question directive; use message-only questions and end the turn');
    if (/\bcontinue independent authorized work\b/i.test(clause) && !/\b(?:never|do not|don't) continue independent authorized work/i.test(clause)) {
      errors.add('superseded question-wait continuation; end the turn until the Human replies');
    }
  }
  return [...errors];
}

export function isQuestionInstructionPath(file) {
  return ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.agents/pipeliner-policy.html'].includes(file)
    || /^(?:\.agents|\.claude)\/skills\/.*\.(?:md|html|ya?ml)$/.test(file);
}
