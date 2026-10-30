"""Bounded public plans for durable goal turns. Model reports are not proof."""
import copy
import json
import re

# The Portal limits that stop a round without ending its goal (pixel_outcome
# `stop`, set by the Pixel plugin's tool-loop-guard). The next round continues
# from the saved work, within the same round and stall limits as any other.
GOAL_CONTINUE_STOPS = frozenset({'tool-limit', 'run-deadline'})
_STOP_NOTES = {
    'tool-limit': "The last round was stopped by Portal's tool limit before it finished. ",
    'run-deadline': 'The last round was stopped by the 30-minute limit before it finished. ',
}


def public_plan(value):
    def text(v, limit):
        return isinstance(v, str) and 0 < len(v.strip()) <= len(v) <= limit and not re.search(r'[\x00-\x1f\x7f]', v)
    if not isinstance(value, dict) or set(value) != {'status', 'summary', 'steps'}:
        return None
    if value['status'] not in ('active', 'completed', 'blocked', 'waiting') or not text(value['summary'], 300):
        return None
    if not isinstance(value['steps'], list) or len(value['steps']) > 8:
        return None
    ids = set()
    for step in value['steps']:
        if not isinstance(step, dict) or set(step) != {'id', 'title', 'status'}:
            return None
        if not isinstance(step['id'], str) or not re.fullmatch(r'[a-z][a-z0-9_]{0,31}', step['id']) or step['id'] in ids:
            return None
        if not text(step['title'], 160) or step['status'] not in ('pending', 'running', 'completed', 'blocked'):
            return None
        ids.add(step['id'])
    if value['status'] == 'completed' and (not ids or any(s['status'] != 'completed' for s in value['steps'])):
        return None
    return copy.deepcopy(value)


def goal_prompt(row, agent, answer=''):
    # Pixel's goal note points its language rule at the owner's words, and its
    # stop synthesis reads them: the goal before "Continue this goal from the
    # saved work." and the "Owner's answers:" (pixel-agent
    # plugin/response-language.mjs).
    plan = agent.get('goal_plan')
    answers = agent.get('goal_answers', '')
    if answer:
        answers = (answers + '\n\n' + answer).strip()
    completion_hint = ''
    if plan and plan['steps']:
        completed = {**plan, 'status':'completed', 'summary':'Requested outcome checked',
                     'steps':[{**step, 'status':'completed'} for step in plan['steps']]}
        completion_hint = ('\nReview the previous response against the objective now. Do missing work if necessary. '
                           'If the result already fulfills ALL requirements, do not repeat the work: '
                           'record completion via tool_call, id="pixel_ods_goal", args='
                           + json.dumps(completed, ensure_ascii=False) + '. '
                           'Use these completion arguments ONLY after checking the result. '
                           'Then deliver the checked result. Do not merely restate an answer while leaving the plan unfinished.\n')
    plan_text = ('\n'.join(f"{step['id']}: {step['title']} [{step['status']}]" for step in plan['steps']) if plan else '')
    # After "Continue this goal from the saved work.": Pixel reads the text
    # before that sentence as the owner's words.
    stop_note = _STOP_NOTES.get(agent.get('goal_stopped'), '')
    prompt = (f"/goal {row['goal']}\n\n"
            f"Continue this goal from the saved work. {stop_note}Do only unfinished work. "
            "Inspect uncertain effects before acting; never repeat a completed write or publication. "
            "Use pixel_ods_goal to record actual progress and completion; preserve existing step IDs and titles. "
            "When everything is done, report completed through that tool and deliver the actual final answer. "
            "Ask the owner with pixel_ods_ask_user when their input is necessary. "
            "All existing tool permissions still apply. Do not create other agents.\n"
            f"Conversation context (background only):\n{row['context'][:600]}\n"
            + (f"Saved public plan (model-reported):\n{plan_text}\n" if plan_text else '')
            + (f"Owner's answers:\n{answers}\n" if answers else ''))
    # The exact completion example is optional. Never trim the objective,
    # decisions or plan to make room for extra coaching on a small context.
    return prompt + completion_hint if len(prompt + completion_hint) <= 16384 else prompt


def round_file_edits(activity):
    """Successful file-changing calls of one round, from its public activity."""
    for item in (activity or {}).get('activities') or []:
        if isinstance(item, dict) and item.get('kind') == 'edit':
            calls, failures = item.get('calls'), item.get('failures')
            if type(calls) is int and type(failures) is int and calls >= failures >= 0:
                return calls - failures
    return 0


def goal_decision(agent, stopped=None):
    """Called only after a successful, verified terminal transport receipt, or
    after a round that one of GOAL_CONTINUE_STOPS stopped (`stopped`)."""
    plan = public_plan((agent.get('activity') or {}).get('goal'))
    old = agent.get('goal_plan')
    if old and old['steps'] and plan and plan['steps'] and [(s['id'], s['title']) for s in old['steps']] != [(s['id'], s['title']) for s in plan['steps']]:
        return 'The model replaced its unfinished plan. Saved work was preserved; review it before continuing.'
    if plan and plan['steps']:
        agent['goal_plan'] = plan
    if plan and plan['status'] == 'completed':
        return None
    # A stopped round's plan is marked blocked by Pixel itself, not by the
    # model, so only a model's own blocked report ends the goal.
    if plan and (plan['status'] == 'waiting' or (plan['status'] == 'blocked' and not stopped)):
        return plan['summary']
    completed = sorted(s['id'] for s in (plan or {}).get('steps', []) if s['status'] == 'completed')
    # Progress is a newly completed step or a changed file: a long build keeps
    # its "work" step running for many rounds while files change.
    progressed = completed != agent.get('goal_progress', []) or round_file_edits(agent.get('activity')) > 0
    agent['goal_stalls'] = 0 if progressed else agent.get('goal_stalls', 0) + 1
    agent['goal_progress'] = completed
    agent['goal_stopped'] = stopped
    if agent['goal_stalls'] >= 4 or agent.get('goal_round', 0) >= 11:
        return 'The goal is incomplete. Automatic continuation paused because progress could not be confirmed or the turn limit was reached.'
    return 'continue'
