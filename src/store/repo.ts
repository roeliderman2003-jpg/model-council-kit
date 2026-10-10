import * as crypto from 'node:crypto';
import type { Store } from './db';
import type { Author, ComparisonResult, MetricType, RouteMode, Sensitivity, TaskType, Usage } from '../types';

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

export interface TaskRow {
  id: string;
  created_at: string;
  task_type: string;
  mode: string;
  mode_reason: string;
  sensitivity: string;
  irreversible: number;
  high_stakes: number;
  prompt_version: string;
  config_version: string;
  input_hash: string;
  request_excerpt: string | null;
  is_shadow: number;
}

export interface CreateTaskInput {
  task_type: TaskType;
  mode: RouteMode;
  mode_reason: string;
  sensitivity: Sensitivity;
  irreversible: boolean;
  high_stakes: boolean;
  prompt_version: string;
  config_version: string;
  input_hash: string;
  /** Short excerpt for the history view. Redacted before it gets here. */
  request_excerpt?: string;
  is_shadow?: boolean;
}

export function createTask(store: Store, input: CreateTaskInput): string {
  const id = newId('task');
  store.run(
    `INSERT INTO tasks (id, created_at, task_type, mode, mode_reason, sensitivity, irreversible,
       high_stakes, prompt_version, config_version, input_hash, request_excerpt, is_shadow)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    new Date().toISOString(),
    input.task_type,
    input.mode,
    input.mode_reason,
    input.sensitivity,
    input.irreversible ? 1 : 0,
    input.high_stakes ? 1 : 0,
    input.prompt_version,
    input.config_version,
    input.input_hash,
    input.request_excerpt ?? null,
    input.is_shadow ? 1 : 0,
  );
  return id;
}

export function getTask(store: Store, taskId: string): TaskRow | undefined {
  return store.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', taskId);
}

export interface RecordCandidateInput {
  task_id: string;
  author: Author;
  model: string;
  text: string;
  usage?: Usage;
  /** Only honoured when privacy.store_full_content is on. */
  storeContent: boolean;
}

export function recordCandidate(store: Store, input: RecordCandidateInput): string {
  const id = newId('cand');
  store.run(
    `INSERT INTO candidates (id, task_id, author, model, candidate_hash, content,
       input_tokens, output_tokens, cost_usd, latency_ms, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    input.task_id,
    input.author,
    input.model,
    sha256(input.text),
    input.storeContent ? input.text : null,
    input.usage?.input_tokens ?? 0,
    input.usage?.output_tokens ?? 0,
    input.usage?.cost_usd ?? 0,
    input.usage?.latency_ms ?? 0,
    new Date().toISOString(),
  );
  return id;
}

export interface RecordEvaluationInput {
  task_id: string;
  evaluator_model: string;
  rubric_id: string;
  rubric_version: string;
  seed: string;
  /** Which judge position each side occupied, e.g. {"A":2,"B":1}. */
  position_map: Record<'A' | 'B', 1 | 2>;
  author_a: Author;
  author_b: Author;
  result: ComparisonResult;
}

export function recordEvaluation(store: Store, input: RecordEvaluationInput): string {
  const id = newId('eval');
  const r = input.result;
  store.run(
    `INSERT INTO evaluations (id, task_id, evaluator_model, rubric_id, rubric_version, seed,
       position_map, author_a, author_b, scores_json, hard_failures_json, score_a, score_b,
       gap, threshold, confidence, verdict, decided_by, rationale, escalation_json, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    input.task_id,
    input.evaluator_model,
    input.rubric_id,
    input.rubric_version,
    input.seed,
    JSON.stringify(input.position_map),
    input.author_a,
    input.author_b,
    JSON.stringify(r.per_criterion),
    JSON.stringify({ a: r.hard_failures_a, b: r.hard_failures_b }),
    r.score_a,
    r.score_b,
    r.gap,
    r.threshold,
    r.confidence,
    r.verdict,
    r.decided_by,
    r.concise_rationale,
    JSON.stringify(r.escalation_reasons),
    new Date().toISOString(),
  );
  return id;
}

export interface EvaluationRow {
  id: string;
  task_id: string;
  evaluator_model: string;
  rubric_id: string;
  author_a: Author;
  author_b: Author;
  score_a: number;
  score_b: number;
  gap: number;
  confidence: number;
  verdict: string;
  decided_by: string;
  created_at: string;
}

export function getEvaluations(store: Store, taskId: string): EvaluationRow[] {
  return store.all<EvaluationRow>(
    'SELECT * FROM evaluations WHERE task_id = ? ORDER BY created_at ASC',
    taskId,
  );
}

export interface RecordOutcomeInput {
  task_id: string;
  chosen_author: Author;
  metric_type: MetricType;
  metric_value: number;
  window: string;
  notes?: string;
  is_final: boolean;
}

export function recordOutcome(store: Store, input: RecordOutcomeInput): string {
  const id = newId('outc');
  store.run(
    `INSERT INTO outcomes (id, task_id, chosen_author, metric_type, metric_value, window, notes, is_final, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id,
    input.task_id,
    input.chosen_author,
    input.metric_type,
    input.metric_value,
    input.window,
    input.notes ?? null,
    input.is_final ? 1 : 0,
    new Date().toISOString(),
  );
  return id;
}

export interface OutcomeRow {
  id: string;
  task_id: string;
  chosen_author: Author;
  metric_type: MetricType;
  metric_value: number;
  window: string;
  notes: string | null;
  is_final: number;
  created_at: string;
}

export function getOutcomes(store: Store, taskId: string): OutcomeRow[] {
  return store.all<OutcomeRow>('SELECT * FROM outcomes WHERE task_id = ? ORDER BY created_at ASC', taskId);
}

export function recordUsage(
  store: Store,
  usage: Usage & { task_id?: string; purpose: string },
): void {
  const now = new Date();
  const iso = now.toISOString();
  store.run(
    `INSERT INTO usage_log (id, ts, day, month, task_id, model, purpose, input_tokens, output_tokens, cost_usd, latency_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    newId('use'),
    iso,
    iso.slice(0, 10),
    iso.slice(0, 7),
    usage.task_id ?? null,
    usage.model,
    usage.purpose,
    usage.input_tokens,
    usage.output_tokens,
    usage.cost_usd,
    usage.latency_ms,
  );
}

export function spentToday(store: Store, day = new Date().toISOString().slice(0, 10)): number {
  const row = store.get<{ total: number | null }>(
    'SELECT SUM(cost_usd) AS total FROM usage_log WHERE day = ?',
    day,
  );
  return row?.total ?? 0;
}

export function spentThisMonth(store: Store, month = new Date().toISOString().slice(0, 7)): number {
  const row = store.get<{ total: number | null }>(
    'SELECT SUM(cost_usd) AS total FROM usage_log WHERE month = ?',
    month,
  );
  return row?.total ?? 0;
}

export function spentOnTask(store: Store, taskId: string): number {
  const row = store.get<{ total: number | null }>(
    'SELECT SUM(cost_usd) AS total FROM usage_log WHERE task_id = ?',
    taskId,
  );
  return row?.total ?? 0;
}

export function callsOnTask(store: Store, taskId: string): number {
  const row = store.get<{ n: number }>('SELECT COUNT(*) AS n FROM usage_log WHERE task_id = ?', taskId);
  return row?.n ?? 0;
}

/** Deletes every row for a task. Used by the history-purge command. */
export function deleteTask(store: Store, taskId: string): void {
  store.run('DELETE FROM outcomes WHERE task_id = ?', taskId);
  store.run('DELETE FROM evaluations WHERE task_id = ?', taskId);
  store.run('DELETE FROM candidates WHERE task_id = ?', taskId);
  store.run('DELETE FROM usage_log WHERE task_id = ?', taskId);
  store.run('DELETE FROM tasks WHERE id = ?', taskId);
}

export { sha256 };
