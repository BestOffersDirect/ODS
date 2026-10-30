import test from 'node:test';
import assert from 'node:assert/strict';
import {createToolLoopGuard, EDIT_EARLY_NOTICE, EDIT_EARLY_NOTICES, EDIT_EARLY_READS} from '../plugin/tool-loop-guard.mjs';
import {contractSize, longTaskContract, ODS_LONG_TASK_CONTRACT, ODS_CONVERSATION_CONTRACT,
  promptContractForAgent} from '../plugin/prompt-contract.mjs';

// On the laptop (2026-10-30) a 227-call elf-of-doom run read all of ui.js
// about nine times and never edited: the tool-result projection had already
// dropped its earlier reads. Large-context runs get one fixed line about what
// stays in view, and after many reads with no file change one notice asks the
// model to record what it needs and start changing files. Each case replays
// OpenClaw's hook sequence for one model round and one call, in both the
// direct and the Tool Search transport.
const prompt = 'In elf-of-doom, big fights lag. Make normal enemies draw from a sprite cache instead.';
const printed = n => ({content:[{type:'text', text:`${n}: const x = ${n};`}], details:{status:'completed', exitCode:0, durationMs:3}});
const edited = {content:[{type:'text', text:'Successfully replaced 1 block(s) in Playground/elf-of-doom/ui.js.'}], details:{}};

function harness({wrapped = false} = {}) {
  const guard = createToolLoopGuard();
  const context = {agentId:'pixel', runId:'run', sessionId:'owner-session', sessionKey:'owner-key'};
  guard.observeRun(context, 'pixel', {prompt});
  let sequence = 0;
  function step(name, args, inner, id = `${name}-${++sequence}`) {
    guard.observeModelCall({}, context);
    const toolName = wrapped ? 'tool_call' : name;
    const params = wrapped ? {id:`openclaw:core:${name}`, args} : args;
    const ctx = {...context, toolName, toolCallId:id};
    const decision = guard.beforeToolCall({toolName, params, toolCallId:id}, ctx);
    assert.notEqual(decision?.block, true, decision?.blockReason);
    const executed = wrapped ? decision?.params ?? params : {...params, ...decision?.params};
    const envelope = {tool:{id:`openclaw:core:${name}`, name, source:'openclaw', sourceName:'core'}, result:inner};
    const result = wrapped ? {content:[{type:'text', text:JSON.stringify(envelope)}], details:envelope} : inner;
    guard.afterToolCall({toolName, params:executed, toolCallId:id, result}, ctx);
    const message = {role:'toolResult', toolName, toolCallId:id, isError:false, ...structuredClone(result)};
    const persisted = guard.toolResultPersist({toolName, toolCallId:id, message}, ctx)?.message ?? message;
    return persisted.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  }
  const read = n => step('read', {path:`Playground/elf-of-doom/ui.js`, offset:n * 40 + 1, limit:40}, printed(n));
  const exec = n => step('exec', {command:`grep -n "name${n}" ui.js`, workdir:'/workspace/Playground/elf-of-doom'}, printed(n));
  const edit = n => step('edit', {path:'Playground/elf-of-doom/ui.js', edits:[{oldText:`a${n}`, newText:`b${n}`}]}, edited);
  return {read, exec, edit, step};
}
const noticed = text => text.endsWith(`\n${EDIT_EARLY_NOTICE}`);

test('large-context runs get one fixed long-task line; small contracts and reviewers do not', () => {
  for (const [options, context, size] of [
    [{}, {agentId:'pixel'}, 'full'],
    [{configuredContextWindow:131072}, {agentId:'pixel'}, 'full'],
    [{configuredContextWindow:32769}, {agentId:'pixel'}, 'full'],
    [{configuredContextWindow:32768}, {agentId:'pixel'}, 'compact'],
    [{configuredContextWindow:131072, configuredLeanPrompt:true}, {agentId:'pixel'}, 'compact'],
    [{configuredContextWindow:131072}, {agentId:'pixel', contextTokenBudget:16384}, 'compact'],
    [{configuredContextWindow:8192}, {agentId:'pixel'}, 'tiny'],
    [{configuredContextWindow:131072, configuredLeanPrompt:true}, {agentId:'pixel', contextWindowReferenceTokens:8192}, 'tiny'],
  ]) {
    assert.equal(contractSize(context, options), size, JSON.stringify([options, context]));
    assert.equal(longTaskContract(context, undefined, options), size === 'full' ? ODS_LONG_TASK_CONTRACT : '');
  }
  // The conversation contract itself, and with it the compact and tiny ones, is unchanged.
  assert.equal(promptContractForAgent({agentId:'pixel'}, 'pixel').appendSystemContext, ODS_CONVERSATION_CONTRACT);
  assert.ok(!ODS_CONVERSATION_CONTRACT.includes(ODS_LONG_TASK_CONTRACT));
  assert.match(ODS_LONG_TASK_CONTRACT, /most recent tool output in view/);
  assert.match(ODS_LONG_TASK_CONTRACT, /explanation of update_plan/);
  assert.match(ODS_LONG_TASK_CONTRACT, /make the first change as soon as you know enough for it/);
  // Team roles that plan or review do not change files.
  const teamTurn = role => ({messages:[{role:'user', content:`You are the ${role} in the owner's Portal team. Your assignment: x`}]});
  for (const role of ['Coordinator', 'Reviewer']) assert.equal(longTaskContract({agentId:'pixel'}, teamTurn(role)), '', role);
  assert.equal(longTaskContract({agentId:'pixel'}, teamTurn('Builder')), ODS_LONG_TASK_CONTRACT);
});

for (const wrapped of [false, true]) {
  const transport = wrapped ? 'Tool Search' : 'direct';

  test(`${transport}: many reads without a file change bring one notice, at most twice`, () => {
    const run = harness({wrapped});
    const noticedAt = [];
    for (let n = 1; n <= 100; n++) if (noticed(n % 2 ? run.read(n) : run.exec(n))) noticedAt.push(n);
    assert.deepEqual(noticedAt, [EDIT_EARLY_READS, 2 * EDIT_EARLY_READS]);
    assert.equal(noticedAt.length, EDIT_EARLY_NOTICES);
  });

  test(`${transport}: a file change starts the count again`, () => {
    const run = harness({wrapped});
    const noticedAt = [];
    let n = 0;
    for (; n < EDIT_EARLY_READS - 1; n++) assert.equal(noticed(run.read(n)), false);
    assert.equal(noticed(run.edit(0)), false);
    const firstAfterEdit = n;
    for (; n < 2 * EDIT_EARLY_READS + 5; n++) if (noticed(run.read(n))) noticedAt.push(n);
    // The thirtieth read after the edit, not the thirtieth since the run began.
    assert.deepEqual(noticedAt, [firstAfterEdit + EDIT_EARLY_READS - 1]);
  });
}

test('the notice is fixed text in a block of its own after the result', () => {
  const run = harness();
  let text;
  for (let n = 1; n <= EDIT_EARLY_READS; n++) text = run.read(n);
  assert.equal(text, `${EDIT_EARLY_READS}: const x = ${EDIT_EARLY_READS};\n${EDIT_EARLY_NOTICE}`);
  assert.match(EDIT_EARLY_NOTICE, /^\[ODS Pixel next step\] /);
  assert.match(EDIT_EARLY_NOTICE, /If the owner asked only for an explanation or a review, answer from what you have read\.$/);
});
