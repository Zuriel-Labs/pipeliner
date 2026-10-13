import { sourceSecretPattern } from '../development/source.mjs';

// Qualification output is renderer data; prose never becomes configuration or host code.
export function taskHTML(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > 524288) throw new Error('task-html-denied');
  const blocks = [...content.matchAll(/^```([^\r\n]*)\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)];
  if (blocks.length && (blocks.length !== 1 || blocks[0][1].trim().toLowerCase() !== 'html')) throw new Error('task-html-denied');
  const html = (blocks.length ? blocks[0][2] : content).trim();
  if (Buffer.byteLength(html) > 131072 || !/^<!doctype html>/i.test(html) || !/<\/html>$/i.test(html)
    || sourceSecretPattern.test(html) || /(?:https?:\/\/|<iframe|<webview|<object|\bimport\s|\beval\s*\()/i.test(html)) throw new Error('task-html-denied');
  return html;
}
