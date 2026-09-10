import assert from 'node:assert/strict';
import test from 'node:test';
import { validateOperationalText } from '../scripts/lib/validation.mjs';

test('known question conflicts include desktop feature, native tools and continued work', () => {
  for (const text of [
    'Make it clear you are asking questions using the GPT feature to do this BUT do not put a timer on it.',
    'Use request_user_input for clarification.',
    'Use `request_user_input_async` to ask the user.',
    'Call AskUserQuestion when information is missing.',
    'Prefer native question controls.',
    'Pause only dependent work; continue independent authorized work.',
    'Agents preserve previous answers and continue independent authorized work.',
  ]) assert.ok(validateOperationalText(text).length, text);
});

test('question prohibitions and unrelated independent work remain valid', () => {
  for (const text of [
    'Never use request_user_input or AskUserQuestion.',
    'Do not use native question controls.',
    'Use ordinary messages marked Question: and end the turn.',
    'Run independent tests before asking the Human.',
    'The agent asks in a message. No background continuation while awaiting an answer.',
  ]) assert.deepEqual(validateOperationalText(text), [], text);
});
