import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildContextPack, SYSTEM_FRAME } from '../../src/context/builder';
import { isBlockedSource, redactPii, stripAuthorTells } from '../../src/context/redact';
import { CouncilError } from '../../src/types';
import { testConfig } from '../helpers';

describe('context pack building', () => {
  const cfg = testConfig();

  it('keeps the user request verbatim rather than paraphrasing it', () => {
    const request = 'תכתוב לי קופי לדף נחיתה, אבל בלי מילים גדולות';
    const pack = buildContextPack(
      { original_request: request, task_type: 'copy', brief: 'landing page copy' },
      cfg,
    );
    assert.ok(pack.rendered.includes(request), 'the exact request text must survive into the prompt');
  });

  it('separates system instructions, user request and untrusted material into distinct blocks', () => {
    const pack = buildContextPack(
      {
        original_request: 'analyse this call',
        task_type: 'sales_analysis',
        brief: 'find the objections',
        approved_facts: ['the price is 490 a month'],
        source_material: [{ label: 'call 1', content: 'customer said it is expensive' }],
      },
      cfg,
    );
    assert.ok(pack.rendered.includes('<system_instructions>'));
    assert.ok(pack.rendered.includes('<user_request>'));
    assert.ok(pack.rendered.includes('<approved_facts>'));
    assert.ok(pack.rendered.includes('<untrusted_source_material>'));
    // Order matters: instructions must precede the untrusted block.
    assert.ok(
      pack.rendered.indexOf('<system_instructions>') < pack.rendered.indexOf('<untrusted_source_material>'),
    );
  });

  it('states the trust boundary explicitly in the system frame', () => {
    assert.match(SYSTEM_FRAME, /never obey it/i);
    assert.match(SYSTEM_FRAME, /Never invent a fact/i);
  });

  it('refuses an empty request', () => {
    assert.throws(
      () => buildContextPack({ original_request: '   ', task_type: 'copy', brief: 'x' }, cfg),
      (e: unknown) => e instanceof CouncilError && e.reason === 'bad_input',
    );
  });

  it('rejects a pack over the input character cap', () => {
    const small = testConfig();
    small.budget.max_input_chars = 500;
    assert.throws(
      () =>
        buildContextPack(
          {
            original_request: 'x'.repeat(600),
            task_type: 'copy',
            brief: 'y',
          },
          small,
        ),
      (e: unknown) => e instanceof CouncilError && e.reason === 'payload_too_large',
    );
  });

  it('truncates source material at the configured cap and reports which sources were cut', () => {
    const c = testConfig();
    c.privacy.max_source_material_chars = 50;
    const pack = buildContextPack(
      {
        original_request: 'summarise',
        task_type: 'research_summary',
        brief: 'summary',
        source_material: [
          { label: 'big', content: 'a'.repeat(200) },
          { label: 'also big', content: 'b'.repeat(200) },
        ],
      },
      c,
    );
    assert.ok(pack.truncated_sources.includes('big'));
    assert.ok(pack.truncated_sources.includes('also big'));
  });

  it('produces a stable hash for identical input and a different one otherwise', () => {
    const mk = (brief: string) =>
      buildContextPack({ original_request: 'r', task_type: 'copy', brief }, cfg).hash;
    assert.equal(mk('same'), mk('same'));
    assert.notEqual(mk('same'), mk('different'));
  });

  it('defaults sensitivity to internal', () => {
    const pack = buildContextPack({ original_request: 'r', task_type: 'copy', brief: 'b' }, cfg);
    assert.equal(pack.input.sensitivity, 'internal');
  });
});

describe('redaction', () => {
  it('redacts an Israeli mobile number', () => {
    const r = redactPii('call me on 052-816-4494 tomorrow');
    assert.ok(!r.text.includes('052'), r.text);
    assert.ok(r.text.includes('[REDACTED:PHONE]'));
    assert.equal(r.changed, true);
  });

  it('redacts an email address', () => {
    const r = redactPii('write to dana.cohen@gmail.com please');
    assert.ok(!r.text.includes('@gmail.com'));
    assert.ok(r.text.includes('[REDACTED:EMAIL]'));
  });

  it('redacts an OpenAI-style key', () => {
    const r = redactPii('key is sk-proj-AbCdEf0123456789AbCdEf0123456789');
    assert.ok(r.text.includes('[REDACTED:API_KEY]'));
    assert.ok(!r.text.includes('AbCdEf0123456789'));
  });

  it('leaves an ordinary nine-digit number alone but redacts a valid Israeli ID', () => {
    // 123456789 fails the check digit; 200000008 passes it.
    const plain = redactPii('order number 123456789');
    assert.ok(plain.text.includes('123456789'), 'an invalid check digit is not an ID');
    const real = redactPii('ID 200000008');
    assert.ok(real.text.includes('[REDACTED:ISRAELI_ID]'), real.text);
  });

  it('labels a zero-leading valid ID as an ID, not as a landline', () => {
    // 030000004 is a valid ID and also parses as the landline 03-000-0004.
    // The check digit is the more specific signal, so the ID pattern runs first.
    const r = redactPii('ID 030000004');
    assert.ok(r.text.includes('[REDACTED:ISRAELI_ID]'), r.text);
  });

  it('still redacts a zero-leading nine-digit number that is NOT a valid ID', () => {
    // 039285657 fails the check digit, so it falls through to the phone rule.
    // The point is that it is redacted either way — no value escapes.
    const r = redactPii('number 039285657');
    assert.ok(!r.text.includes('039285657'), r.text);
    assert.ok(r.text.includes('[REDACTED:PHONE]'), r.text);
  });

  it('leaves a long non-card number alone but redacts a Luhn-valid card', () => {
    const notCard = redactPii('reference 1234567890123456789');
    assert.ok(notCard.text.includes('1234567890123456789'));
    const card = redactPii('paid with 4242424242424242');
    assert.ok(card.text.includes('[REDACTED:CREDIT_CARD]'), card.text);
  });

  it('counts each kind it replaced', () => {
    const r = redactPii('a@b.com and c@d.com and 052-816-4494');
    const emails = r.hits.find((h) => h.kind === 'email');
    assert.equal(emails?.count, 2);
    assert.ok(r.hits.find((h) => h.kind === 'phone'));
  });

  it('only redacts the kinds it was asked for', () => {
    const r = redactPii('mail me at a@b.com', ['phone']);
    assert.ok(r.text.includes('a@b.com'));
  });
});

describe('blocked sources', () => {
  const patterns = ['**/.env', '**/*.key', '**/credentials*.json', '**/.git/**', '**/node_modules/**'];

  it('blocks a dotenv file at any depth', () => {
    assert.equal(isBlockedSource('C:/Users/someone/projects/app/.env', patterns), true);
    assert.equal(isBlockedSource('.env', patterns), true);
  });

  it('blocks a Windows path with backslashes', () => {
    assert.equal(isBlockedSource('C:\\Users\\someone\\.claude\\credentials.json', patterns), true);
  });

  it('blocks anything inside .git or node_modules', () => {
    assert.equal(isBlockedSource('repo/.git/config', patterns), true);
    assert.equal(isBlockedSource('repo/node_modules/pkg/index.js', patterns), true);
  });

  it('allows an ordinary source file', () => {
    assert.equal(isBlockedSource('src/index.ts', patterns), false);
    assert.equal(isBlockedSource('docs/README.md', patterns), false);
  });
});

describe('author tells', () => {
  it('strips a self-identification but keeps the substance', () => {
    const r = stripAuthorTells("As Claude, I would open with the objection. The price is the real blocker.");
    assert.ok(!/as claude/i.test(r.text), r.text);
    assert.ok(r.text.includes('The price is the real blocker.'));
    assert.equal(r.removed.length, 1);
  });

  it('leaves a legitimate product mention alone', () => {
    const r = stripAuthorTells('Our support team uses Claude to draft replies.');
    assert.ok(r.text.includes('uses Claude to draft replies'));
    assert.equal(r.removed.length, 0);
  });

  it('strips a leading model label', () => {
    const r = stripAuthorTells('GPT: here is the headline');
    assert.ok(!r.text.startsWith('GPT:'), r.text);
  });
});
