import test from 'node:test';
import assert from 'node:assert/strict';
import {parseVerificationResponse} from '../host/pixel_ingress.mjs';
import {createToolLoopGuard} from '../plugin/tool-loop-guard.mjs';
import {RUN_PROGRESS_LIMITS} from '../plugin/run-progress-budget.mjs';

// A failed response says which Portal limit stopped it, so goal mode's
// controller (dashboard-api portal_goal.py) can continue the goal from the
// saved work instead of ending it (laptop, 2026-10-30: long changes stop at
// the tool limit). The ingress passes only known stops on failed outcomes.
const RUN_ID = 'chatcmpl_5b2c1d0e-7a1f-4e3b-9c2d-1f0e3a4b5c6d';

test('the ingress accepts a known stop on a failed outcome and nothing else', () => {
  for (const stop of ['tool-limit', 'run-deadline']) {
    assert.deepEqual(parseVerificationResponse({status: 'failed', text: 'Stopped.', stop}, RUN_ID),
      {status: 'failed', text: 'Stopped.', stop});
  }
  for (const value of [
    {status: 'failed', text: 'Stopped.', stop: 'output-limit'},
    {status: 'failed', text: 'Stopped.', stop: ['tool-limit']},
    {status: 'failed', text: 'Stopped.', stop: ''},
    {status: 'passed', text: 'Done.', stop: 'tool-limit'},
    {status: 'none', stop: 'run-deadline'},
    {status: 'pending', text: 'Which one?', stop: 'tool-limit'},
  ]) assert.throws(() => parseVerificationResponse(value, RUN_ID), /verification state unavailable/, JSON.stringify(value));
});

test('a run the tool limit stopped says so; an ordinary run does not', () => {
  const run = ({failures = RUN_PROGRESS_LIMITS.consecutiveFailures} = {}) => {
    const guard = createToolLoopGuard({abortRun: () => true});
    const context = {agentId: 'pixel', runId: 'run', sessionId: 'owner-session', sessionKey: 'owner-key'};
    guard.observeRun(context, 'pixel', {prompt: 'Fix the enemy drawing in Playground/game.'});
    for (let i = 0; i < failures; i++) {
      const toolCallId = `read-${i}`, ctx = {...context, toolName: 'read', toolCallId};
      guard.observeModelCall({}, context);
      guard.beforeToolCall({toolName: 'read', params: {path: `Playground/game/missing-${i}.js`}, toolCallId}, ctx);
      const result = {isError: true, content: [{type: 'text', text: 'ENOENT'}], details: {status: 'error'}};
      guard.afterToolCall({toolName: 'read', params: {path: `Playground/game/missing-${i}.js`}, toolCallId, result, error: 'ENOENT'}, ctx);
      guard.toolResultPersist({toolName: 'read', toolCallId, message: {role: 'toolResult', toolName: 'read', toolCallId, ...result}}, ctx);
    }
    return guard.deliveryVerificationForRun('run');
  };
  const stopped = run();
  assert.equal(stopped.status, 'failed');
  assert.equal(stopped.stop, 'tool-limit');
  assert.deepEqual(parseVerificationResponse(stopped, RUN_ID).stop, 'tool-limit');
  assert.equal(run({failures: 1}).stop, undefined);
});
