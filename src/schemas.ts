import { z } from 'zod';

/**
 * Zod shapes for every MCP tool.
 *
 * These are the validation boundary: nothing reaches a provider, the store or
 * the scoring engine without passing through here first.
 */

export const sensitivityEnum = z.enum(['public', 'internal', 'confidential', 'restricted']);

export const taskTypeEnum = z.enum([
  'code',
  'architecture',
  'tests',
  'ops',
  'feature_spec',
  'copy',
  'marketing_angle',
  'value_proposition',
  'sales_analysis',
  'qualitative_analysis',
  'research_summary',
  'decision',
  'writing',
  'planning',
  'explanation',
  'naming',
  'translation',
  'small_rewrite',
  'other',
]);

export const routeModeEnum = z.enum([
  'CLAUDE_ONLY',
  'GPT_ONLY',
  'COMPETITION',
  'GPT_CRITIQUE',
  'USER_DECIDES',
]);

export const metricTypeEnum = z.enum([
  'was_used',
  'manual_rating',
  'revisions_needed',
  'time_to_complete',
  'rework_minutes',
  'tests_passed',
  'defects_found',
  'cpl',
  'ctr',
  'conversion_rate',
  'lead_quality',
  'close_rate',
  'cancellations',
]);

export const authorEnum = z.enum(['claude', 'gpt', 'user', 'other']);

export const sourceMaterialSchema = z.object({
  label: z.string().min(1).max(200).describe('Short name for this excerpt, e.g. "call transcript 3".'),
  content: z.string().max(100000).describe('The excerpt itself. Send only the passages that matter.'),
  path: z
    .string()
    .optional()
    .describe('Origin path or URL. Checked against the blocked-source list before anything is sent.'),
});

/** gpt_generate input. */
export const gptGenerateShape = {
  original_request: z
    .string()
    .min(1)
    .max(20000)
    .describe("The user's request, verbatim. Do not paraphrase — the model needs what was actually asked."),
  task_type: taskTypeEnum.describe('Task family. Drives the routing default and the rubric.'),
  brief: z.string().min(1).max(20000).describe('What this task must achieve, in your words.'),
  approved_facts: z
    .array(z.string().max(2000))
    .max(100)
    .optional()
    .describe('Facts the user has confirmed. The ONLY facts the model may assert.'),
  constraints: z.array(z.string().max(1000)).max(50).optional().describe('Hard rules the output must respect.'),
  audience: z.string().max(2000).optional().describe('Who this is for.'),
  brand_voice: z.string().max(4000).optional().describe('Voice, register and tone to match.'),
  source_material: z
    .array(sourceMaterialSchema)
    .max(20)
    .optional()
    .describe('Relevant excerpts only. Never a whole repository, wiki or database.'),
  desired_output: z.string().max(2000).optional().describe('The output format expected.'),
  rubric: z
    .string()
    .max(100)
    .optional()
    .describe('Rubric id to show the model as success criteria. Defaults to the one for this task type.'),
  sensitivity: sensitivityEnum.optional().describe('Defaults to internal. `restricted` refuses without approve_restricted.'),
  model_tier: z
    .enum(['generator', 'fast'])
    .optional()
    .describe('`fast` uses the cheaper model. Defaults to generator.'),
  max_output_length: z.number().int().min(50).max(32000).optional().describe('Cap on output tokens.'),
  task_id: z.string().max(80).optional().describe('Attach to an existing task instead of opening a new one.'),
  approve_restricted: z
    .boolean()
    .optional()
    .describe('Explicit approval to send restricted material. Never set this on the user\'s behalf.'),
  dry_run: z
    .boolean()
    .optional()
    .describe('Assemble and return the exact payload without calling the API. Costs nothing.'),
};

/** blind_compare input. */
export const blindCompareShape = {
  original_brief: z.string().min(1).max(20000).describe('The same brief both candidates answered.'),
  candidate_a: z.string().min(1).max(60000).describe('First candidate text.'),
  candidate_b: z.string().min(1).max(60000).describe('Second candidate text.'),
  author_a: authorEnum
    .optional()
    .describe('Who wrote candidate A. Stored for statistics; NEVER sent to the judge.'),
  author_b: authorEnum
    .optional()
    .describe('Who wrote candidate B. Stored for statistics; NEVER sent to the judge.'),
  rubric: z.string().max(100).optional().describe('Rubric id. Defaults to the one matching task_type.'),
  task_type: taskTypeEnum.optional().describe('Used to pick a rubric when none is named.'),
  weights: z
    .record(z.string(), z.number())
    .optional()
    .describe('Per-criterion weight overrides, criterion_id -> weight.'),
  hard_constraints: z
    .array(z.string().max(1000))
    .max(50)
    .optional()
    .describe('Requirements a candidate must satisfy. A violation disqualifies regardless of score.'),
  objective_checks: z
    .array(
      z.object({
        id: z.string().max(100),
        label: z.string().max(300),
        favours: z.enum(['A', 'B', 'neither']).nullable(),
        passed_a: z.boolean().nullable().optional(),
        passed_b: z.boolean().nullable().optional(),
        detail: z.string().max(2000).optional(),
      }),
    )
    .max(50)
    .optional()
    .describe('Test results and measurements. These outrank the rubric scores.'),
  decision_threshold: z
    .number()
    .min(0)
    .max(10)
    .optional()
    .describe('Minimum 0-10 point gap needed to declare a winner. Below it the call goes to the user.'),
  randomization_seed: z
    .string()
    .max(200)
    .optional()
    .describe('Seed for the A/B position draw. Pass the same seed to replay a comparison.'),
  irreversible: z.boolean().optional().describe('Forces the decision to the user regardless of gap.'),
  allow_tie: z
    .boolean()
    .optional()
    .describe('Return TIE instead of escalating when the only issue is a small gap. For low-stakes work.'),
  missing_critical_facts: z
    .array(z.string().max(1000))
    .max(50)
    .optional()
    .describe('Facts you know are missing. Forces escalation.'),
  task_id: z.string().max(80).optional().describe('Attach to an existing task.'),
  dry_run: z.boolean().optional().describe('Return the exact judge prompt without calling the API.'),
};

/** record_outcome input. */
export const recordOutcomeShape = {
  task_id: z.string().min(1).max(80).describe('The task id reported when the work was done.'),
  chosen_author: authorEnum.describe('Whose candidate was actually used.'),
  metric_type: metricTypeEnum.describe('Which metric this value is.'),
  metric_value: z
    .number()
    .describe(
      'The measured value. was_used: 1 if you shipped it, 0 if you rewrote or discarded it. manual_rating: 1-10. Money in shekels, rates as 0-1 or 0-100 — consistently.',
    ),
  window: z
    .string()
    .min(1)
    .max(100)
    .describe('Measurement window, e.g. "2026-08-01..2026-08-31" or "first 14 days".'),
  notes: z.string().max(4000).optional().describe('Anything that qualifies the number.'),
  is_final: z
    .boolean()
    .describe('False for an interim reading that may still move; true when the window has closed.'),
};

/** routing_stats input. */
export const routingStatsShape = {
  task_type: taskTypeEnum.optional().describe('Restrict to one task family.'),
  window_days: z
    .number()
    .int()
    .min(1)
    .max(3650)
    .optional()
    .describe('Only count tasks from the last N days. Omit for all time.'),
  min_sample_size: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe('Rows below this are flagged as too small to act on. Defaults to the config value.'),
};

/** route_task input. */
export const routeTaskShape = {
  original_request: z.string().min(1).max(20000).describe("The user's request, verbatim."),
  task_type: taskTypeEnum.optional().describe('Omit to have it detected from the request.'),
  explicit_mode: routeModeEnum.optional().describe('An explicit user instruction. Always wins.'),
  high_stakes: z.boolean().optional().describe('Marks the task as consequential.'),
  irreversible: z.boolean().optional().describe('Marks the decision as hard to reverse.'),
  money_impact_ils: z.number().min(0).optional().describe('Rough shekel impact of getting this wrong.'),
  shadow_seed: z.string().max(200).optional().describe('Seed for the shadow draw, for reproducibility.'),
};

/** council_config input. */
export const councilConfigShape = {
  section: z
    .enum(['all', 'models', 'budget', 'routing', 'evaluation', 'privacy', 'rubrics'])
    .optional()
    .describe('Which part of the configuration to show. Defaults to all.'),
};

/** register_claude_candidate input. */
export const registerCandidateShape = {
  task_id: z.string().max(80).optional().describe('Existing task. Omit to open a new one.'),
  task_type: taskTypeEnum.describe('Task family.'),
  author: authorEnum.describe("Who produced this candidate. Use 'claude' for your own work."),
  text: z.string().min(1).max(60000).describe('The candidate text.'),
  original_request: z.string().max(20000).optional().describe('Verbatim request, when opening a new task.'),
  mode: routeModeEnum.optional().describe('The working mode this candidate belongs to.'),
  mode_reason: z.string().max(500).optional().describe('One sentence on why that mode.'),
};

export type GptGenerateInput = z.infer<z.ZodObject<typeof gptGenerateShape>>;
export type BlindCompareInput = z.infer<z.ZodObject<typeof blindCompareShape>>;
export type RecordOutcomeInput = z.infer<z.ZodObject<typeof recordOutcomeShape>>;
export type RoutingStatsInput = z.infer<z.ZodObject<typeof routingStatsShape>>;
export type RouteTaskInput = z.infer<z.ZodObject<typeof routeTaskShape>>;
export type RegisterCandidateInput = z.infer<z.ZodObject<typeof registerCandidateShape>>;
