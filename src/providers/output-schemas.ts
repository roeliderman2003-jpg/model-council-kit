/**
 * JSON Schemas for provider output.
 *
 * These live apart from any provider implementation on purpose. They are pure
 * data, shared by every route, and putting them in openai.ts meant that merely
 * describing the expected output pulled in the OpenAI SDK — about 1.1 seconds
 * of module loading that the Codex route never needs. On a cold disk with a
 * dozen MCP servers starting at once, that kind of cost is what turns a working
 * server into one that misses the host's connect timeout.
 */

/** Schema for a generated candidate. */
export const GENERATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'candidate',
    'assumptions',
    'facts_requiring_verification',
    'alternatives',
    'concise_rationale',
    'confidence',
  ],
  properties: {
    candidate: { type: 'string', description: 'The deliverable itself, ready to use.' },
    assumptions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Anything you had to assume because it was not in the approved facts.',
    },
    facts_requiring_verification: {
      type: 'array',
      items: { type: 'string' },
      description: 'Specific claims a human must confirm before this ships.',
    },
    alternatives: {
      type: 'array',
      items: { type: 'string' },
      description: 'Up to three materially different directions you considered and set aside.',
    },
    concise_rationale: {
      type: 'string',
      description: 'Two or three sentences on why this approach. Not a step-by-step of your reasoning.',
    },
    confidence: { type: 'number', description: 'Your confidence in this candidate, 0 to 1.' },
  },
} as const;

/**
 * Schema for the blind evaluation.
 *
 * Note what is absent: there is no `winner`, no `preferred`, no `verdict`. The
 * evaluator cannot express a choice even if it wants to — the constraint is
 * enforced by the schema rather than by an instruction it might drift from.
 */
export function evaluateSchema(criterionIds: string[], hardFailureIds: string[]): Record<string, unknown> {
  const responseReport = {
    type: 'object',
    additionalProperties: false,
    required: ['scores', 'hard_failures', 'key_strength', 'key_risk'],
    properties: {
      scores: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['criterion_id', 'score', 'note'],
          properties: {
            criterion_id: { type: 'string', enum: criterionIds },
            score: { type: 'number', description: '0 to 10.' },
            note: { type: 'string', description: 'One short sentence of evidence for this score.' },
          },
        },
      },
      hard_failures: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['rule_id', 'evidence'],
          properties: {
            rule_id: { type: 'string', enum: hardFailureIds.length ? hardFailureIds : ['none'] },
            evidence: { type: 'string', description: 'Quote the exact text that breaks the rule.' },
          },
        },
      },
      key_strength: { type: 'string' },
      key_risk: { type: 'string' },
    },
  };

  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'response_1',
      'response_2',
      'confidence',
      'concise_rationale',
      'missing_facts',
      'facts_requiring_verification',
    ],
    properties: {
      response_1: responseReport,
      response_2: responseReport,
      confidence: { type: 'number', description: 'How confident you are in these scores, 0 to 1.' },
      concise_rationale: {
        type: 'string',
        description:
          'Two or three sentences comparing the two on the criteria that separated them. Do not name a winner.',
      },
      missing_facts: {
        type: 'array',
        items: { type: 'string' },
        description: 'Facts absent from the brief that you needed in order to score properly.',
      },
      facts_requiring_verification: {
        type: 'array',
        items: { type: 'string' },
        description: 'Claims in either response that a human must verify.',
      },
    },
  };
}
