import test from 'node:test';
import assert from 'node:assert/strict';
import {changedFilesNote, composeProgressFinalization, MAX_CHANGED_FILES_LISTED, PROGRESS_FINALIZATION_NOTE,
  PROGRESS_FINALIZATION_REFUSED_CALLS_NOTE} from '../plugin/progress-finalization.mjs';
import {createToolLoopGuard} from '../plugin/tool-loop-guard.mjs';
import {RUN_PROGRESS_LIMITS, RUN_PROGRESS_STOP_REASON} from '../plugin/run-progress-budget.mjs';

// A stopped response says which files it left changed, from the guard's
// receipts rather than the model's memory. On the laptop (2026-10-30) a stop
// came in the middle of a chars.js change, and the stop answer before it
// described files as "verified" from reads the model could no longer see.

test('the note names the changed files, counts what it does not list, and is empty without changes', () => {
  assert.equal(changedFilesNote([]), '');
  assert.equal(changedFilesNote(undefined), '');
  assert.equal(changedFilesNote(['Playground/elf-of-doom/chars.js']),
    'Files changed in this response: `Playground/elf-of-doom/chars.js`.');
  const many = Array.from({length: MAX_CHANGED_FILES_LISTED + 3}, (_, i) => `game/part-${i}.js`);
  assert.equal(changedFilesNote(many), `Files changed in this response: ${many.slice(0, MAX_CHANGED_FILES_LISTED)
    .map(file => `\`${file}\``).join(', ')}, and 3 more.`);
  // Names that would break the line are counted, not printed.
  assert.equal(changedFilesNote(['ok.js', 'bad`name.js', 'line\nbreak.js']), 'Files changed in this response: `ok.js`, and 2 more.');
  assert.equal(changedFilesNote(['bad`name.js']), '1 file was changed in this response.');
  assert.equal(changedFilesNote(['a`b', 'c`d']), '2 files were changed in this response.');
});

test('a tool-limit answer gets the note right after the stop note', () => {
  const text = composeProgressFinalization('Done so far: the cache is written; the blit is not.', {
    refusedToolCalls: true, changedFiles: ['Playground/elf-of-doom/chars.js']});
  assert.equal(text, 'Done so far: the cache is written; the blit is not.\n\n' +
    `${PROGRESS_FINALIZATION_NOTE}\n\n${PROGRESS_FINALIZATION_REFUSED_CALLS_NOTE}\n\n` +
    'Files changed in this response: `Playground/elf-of-doom/chars.js`.');
  assert.ok(!composeProgressFinalization('Nothing was changed in this run.', {}).includes('Files changed'));
});

test('the tool-limit stop lists the files this response changed, once each, in order', () => {
  const guard = createToolLoopGuard();
  const context = {agentId:'pixel', runId:'run', sessionId:'owner-session', sessionKey:'owner-key'};
  guard.observeRun(context, 'pixel', {prompt:'Fix the enemy drawing in Playground/game.'});
  let sequence = 0;
  const step = (toolName, params, result) => {
    const toolCallId = `${toolName}-${++sequence}`, ctx = {...context, toolName, toolCallId};
    guard.observeModelCall({}, context);
    const decision = guard.beforeToolCall({toolName, params, toolCallId}, ctx);
    assert.notEqual(decision?.block, true, decision?.blockReason);
    guard.afterToolCall({toolName, params:{...params, ...decision?.params}, toolCallId, result,
      ...(result.isError ? {error:result.content[0].text} : {})}, ctx);
    guard.toolResultPersist({toolName, toolCallId, message:{role:'toolResult', toolName, toolCallId, ...structuredClone(result)}}, ctx);
  };
  const edited = {content:[{type:'text', text:'Successfully replaced 1 block(s).'}], details:{}};
  step('edit', {path:'Playground/game/chars.js', edits:[{oldText:'a', newText:'b'}]}, edited);
  step('write', {path:'Playground/game/sprites.js', content:'export const SPRITES = new Map();\n'},
    {content:[{type:'text', text:'Successfully wrote 33 bytes.'}], details:{}});
  step('edit', {path:'Playground/game/chars.js', edits:[{oldText:'c', newText:'d'}]}, edited);
  for (let i = 0; i < RUN_PROGRESS_LIMITS.consecutiveFailures; i++) {
    step('read', {path:`Playground/game/missing-${i}.js`}, {isError:true, content:[{type:'text', text:'ENOENT'}], details:{status:'error'}});
  }
  const delivery = guard.deliveryVerificationForRun('run');
  assert.equal(delivery.status, 'failed');
  assert.ok(delivery.text.startsWith(RUN_PROGRESS_STOP_REASON), delivery.text);
  assert.match(delivery.text, /\n\nFiles changed in this response: `Playground\/game\/chars\.js`, `Playground\/game\/sprites\.js`\./);
});
