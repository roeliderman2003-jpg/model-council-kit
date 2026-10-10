import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIProvider, evaluateSchema, GENERATE_SCHEMA } from '../../src/providers/openai';
import { CouncilError } from '../../src/types';
import { rubricFor } from '../../src/config';
import { testConfig, withEnv } from '../helpers';

/**
 * These drive the REAL OpenAI SDK against a scripted fetch, so the retry,
 * timeout and parsing behaviour under test is the behaviour that ships — not a
 * mock of our own wrapper.
 */

const KEY = 'sk-test-0000000000000000000000000000';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function validCandidateBody(text = 'the headline') {
  const payload = {
    candidate: text,
    assumptions: ['assumed the price is unchanged'],
    facts_requiring_verification: ['the session length'],
    alternatives: ['a fear-based angle'],
    concise_rationale: 'leads with the outcome',
    confidence: 0.77,
  };
  return {
    id: 'resp_123',
    output_text: JSON.stringify(payload),
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(payload) }] }],
    usage: { input_tokens: 1200, output_tokens: 300 },
  };
}

describe('OpenAI provider against a scripted HTTP layer', () => {
  it('parses a well-formed structured response', async () => {
    await withEnv({ OPENAI_API_KEY: KEY }, async () => {
      const provider = new OpenAIProvider(testConfig(), async () => jsonResponse(validCandidateBody()));
      const res = await provider.generate({
        model: 'gpt-5.1',
        prompt: 'a prompt',
        maxOutputTokens: 1000,
        timeoutMs: 5000,
        retries: 0,
        requestLabel: 'test',
      });
      assert.equal(res.output.candidate, 'the headline');
      assert.equal(res.output.confidence, 0.77);
      assert.equal(res.usage.input_tokens, 1200);
      assert.ok(res.usage.cost_usd > 0, 'cost is computed from real token counts');
      assert.equal(res.request_id, 'resp_123');
    });
  });

  it('sends the json_schema format so the model cannot free-form', async () => {
    await withEnv({ OPENAI_API_KEY: KEY }, async () => {
      let sentBody: Record<string, unknown> = {};
      const provider = new OpenAIProvider(testConfig(), async (_url, init) => {
        sentBody = JSON.parse(String((init as RequestInit).body));
        return jsonResponse(validCandidateBody());
      });
      await provider.generate({
        model: 'gpt-5.1',
        prompt: 'a prompt',
        maxOutputTokens: 1234,
        timeoutMs: 5000,
        retries: 0,
        requestLabel: 'test',
      });
      const text = sentBody['text'] as { format: { type: string; strict: boolean } };
      assert.equal(text.format.type, 'json_schema');
      assert.equal(text.format.strict, true);
      assert.equal(sentBody['max_output_tokens'], 1234);
      assert.equal(sentBody['model'], 'gpt-5.1');
    });
  });

  it('retries a 429 and succeeds', async () => {
    await withEnv({ OPENAI_API_KEY: KEY }, async () => {
      let calls = 0;
      const provider = new OpenAIProvider(testConfig(), async () => {
        calls++;
        if (calls === 1) return jsonResponse({ error: { message: 'rate limited' } }, 429);
        return jsonResponse(validCandidateBody('second attempt'));
      });
      const res = await provider.generate({
        model: 'gpt-5.1',
        prompt: 'p',
        maxOutputTokens: 100,
        timeoutMs: 5000,
        retries: 2,
        requestLabel: 'test',
      });
      assert.equal(calls, 2);
      assert.equal(res.output.candidate, 'second attempt');
    });
  });

  it('retries a 500 and succeeds', async () => {
    await withEnv({ OPENAI_API_KEY: KEY }, async () => {
      let calls = 0;
      const provider = new OpenAIProvider(testConfig(), async () => {
        calls++;
        if (calls < 3) return jsonResponse({ error: { message: 'server error' } }, 500);
        return jsonResponse(validCandidateBody());
      });
      const res = await provider.generate({
        model: 'gpt-5.1',
        prompt: 'p',
        maxOutputTokens: 100,
        timeoutMs: 5000,
        retries: 2,
        requestLabel: 'test',
      });
      assert.equal(calls, 3);
      assert.ok(res.output.candidate);
    });
  });

  it('does NOT retry a 400, because retrying our own bad request just pays twice', async () => {
    await withEnv({ OPENAI_API_KEY: KEY }, async () => {
      let calls = 0;
      const provider = new OpenAIProvider(testConfig(), async () => {
        calls++;
        return jsonResponse({ error: { message: 'bad request' } }, 400);
      });
      await assert.rejects(
        provider.generate({
          model: 'gpt-5.1',
          prompt: 'p',
          maxOutputTokens: 100,
          timeoutMs: 5000,
          retries: 3,
          requestLabel: 'test',
        }),
        (e: unknown) => e instanceof CouncilError && e.reason === 'provider_unavailable',
      );
      assert.equal(calls, 1, 'a 400 must be attempted exactly once');
    });
  });

  it('reports a 401 as a credential problem, not a generic outage', async () => {
    await withEnv({ OPENAI_API_KEY: KEY }, async () => {
      const provider = new OpenAIProvider(testConfig(), async () =>
        jsonResponse({ error: { message: 'invalid api key' } }, 401),
      );
      await assert.rejects(
        provider.generate({
          model: 'gpt-5.1',
          prompt: 'p',
          maxOutputTokens: 100,
          timeoutMs: 5000,
          retries: 0,
          requestLabel: 'test',
        }),
        (e: unknown) => {
          assert.ok(e instanceof CouncilError);
          assert.equal(e.reason, 'no_api_key');
          assert.match(e.suggestion, /Claude continues on its own/i);
          return true;
        },
      );
    });
  });

  it('turns a timeout into a typed timeout error that names the limit', async () => {
    await withEnv({ OPENAI_API_KEY: KEY }, async () => {
      const provider = new OpenAIProvider(testConfig(), (_url, init) => {
        // Never resolves; the AbortController must cut it off.
        return new Promise((_resolve, reject) => {
          const signal = (init as RequestInit).signal;
          signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      });
      await assert.rejects(
        provider.generate({
          model: 'gpt-5.1',
          prompt: 'p',
          maxOutputTokens: 100,
          timeoutMs: 60,
          retries: 0,
          requestLabel: 'test',
        }),
        (e: unknown) => {
          assert.ok(e instanceof CouncilError);
          assert.equal(e.reason, 'timeout');
          assert.match(e.message, /60ms/);
          return true;
        },
      );
    });
  });

  it('rejects non-JSON output as invalid_output rather than crashing', async () => {
    await withEnv({ OPENAI_API_KEY: KEY }, async () => {
      const provider = new OpenAIProvider(testConfig(), async () =>
        jsonResponse({ id: 'r', output_text: 'this is not json at all', usage: {} }),
      );
      await assert.rejects(
        provider.generate({
          model: 'gpt-5.1',
          prompt: 'p',
          maxOutputTokens: 100,
          timeoutMs: 5000,
          retries: 0,
          requestLabel: 'test',
        }),
        (e: unknown) => e instanceof CouncilError && e.reason === 'invalid_output',
      );
    });
  });

  it('rejects valid JSON that is missing the candidate', async () => {
    await withEnv({ OPENAI_API_KEY: KEY }, async () => {
      const provider = new OpenAIProvider(testConfig(), async () =>
        jsonResponse({ id: 'r', output_text: JSON.stringify({ confidence: 0.9 }), usage: {} }),
      );
      await assert.rejects(
        provider.generate({
          model: 'gpt-5.1',
          prompt: 'p',
          maxOutputTokens: 100,
          timeoutMs: 5000,
          retries: 0,
          requestLabel: 'test',
        }),
        (e: unknown) => e instanceof CouncilError && e.reason === 'invalid_output',
      );
    });
  });

  it('rejects an empty response', async () => {
    await withEnv({ OPENAI_API_KEY: KEY }, async () => {
      const provider = new OpenAIProvider(testConfig(), async () =>
        jsonResponse({ id: 'r', output_text: '', usage: {} }),
      );
      await assert.rejects(
        provider.generate({
          model: 'gpt-5.1',
          prompt: 'p',
          maxOutputTokens: 100,
          timeoutMs: 5000,
          retries: 0,
          requestLabel: 'test',
        }),
        (e: unknown) => e instanceof CouncilError && e.reason === 'invalid_output',
      );
    });
  });

  it('never leaks the key into a thrown error message', async () => {
    await withEnv({ OPENAI_API_KEY: KEY }, async () => {
      const provider = new OpenAIProvider(testConfig(), async () => {
        throw new Error(`connection failed while using ${KEY}`);
      });
      try {
        await provider.generate({
          model: 'gpt-5.1',
          prompt: 'p',
          maxOutputTokens: 100,
          timeoutMs: 5000,
          retries: 0,
          requestLabel: 'test',
        });
        assert.fail('should have thrown');
      } catch (e) {
        // The SDK replaces a thrown fetch error with its own "Connection
        // error.", so the key never survives that path. The property that
        // matters is the absence of the key, whichever layer removed it.
        const msg = (e as Error).message;
        assert.ok(!msg.includes('sk-test'), msg);
        assert.ok(!msg.includes(KEY), msg);
      }
    });
  });
});

describe('output schemas', () => {
  it('gives the evaluator no field in which to name a winner', () => {
    const copy = rubricFor('copy');
    const schema = evaluateSchema(
      copy.criteria.map((c) => c.id),
      copy.hard_failures.map((h) => h.id),
    );
    // The ban is on a FIELD in which a winner could be expressed. The word
    // itself does appear once, in the instruction telling the judge not to name
    // one — removing that would weaken the schema, not strengthen it.
    const props = (schema as { properties: Record<string, unknown> }).properties;
    const fieldNames = JSON.stringify(Object.keys(props)).toLowerCase();
    for (const forbidden of ['winner', 'preferred', 'verdict', 'better', 'choice', 'recommend']) {
      assert.ok(!fieldNames.includes(forbidden), `the evaluator must have no "${forbidden}" field`);
    }
    const perResponse = (props['response_1'] as { properties: Record<string, unknown> }).properties;
    for (const forbidden of ['winner', 'preferred', 'verdict', 'better']) {
      assert.ok(
        !JSON.stringify(Object.keys(perResponse)).toLowerCase().includes(forbidden),
        `a per-response report must have no "${forbidden}" field`,
      );
    }
    assert.deepEqual(Object.keys(props).sort(), [
      'concise_rationale',
      'confidence',
      'facts_requiring_verification',
      'missing_facts',
      'response_1',
      'response_2',
    ]);
  });

  it('constrains criterion ids to the rubric, so the model cannot invent one', () => {
    const schema = evaluateSchema(['a', 'b'], ['x']);
    const enumIds = JSON.stringify(schema).match(/"enum":\["a","b"\]/);
    assert.ok(enumIds, 'criterion_id must be an enum of the rubric ids');
  });

  it('requires every generator field, so a partial answer is rejected upstream', () => {
    assert.deepEqual([...GENERATE_SCHEMA.required].sort(), [
      'alternatives',
      'assumptions',
      'candidate',
      'concise_rationale',
      'confidence',
      'facts_requiring_verification',
    ]);
    assert.equal(GENERATE_SCHEMA.additionalProperties, false);
  });
});
