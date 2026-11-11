import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.GPT_API_KEY = 'test-openai-key';
process.env.CHANNEL3_API_KEY = '';
process.env.DB_FILE = ':memory:';

const { config, describeModes, llmProvider } = await import('../src/config.ts');
const { structured, runAgent, usage } = await import('../src/ai/llm.ts');
const { seedDemo } = await import('../src/demo.ts');
const { homePage } = await import('../src/web/pages.ts');

function stubOpenAI(reply: (body: any, step: number) => unknown) {
  const real = globalThis.fetch;
  const seen: any[] = [];
  globalThis.fetch = (async (url: string, init: any) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(init.headers.Authorization, 'Bearer test-openai-key');
    const body = JSON.parse(init.body);
    seen.push(body);
    return new Response(JSON.stringify(reply(body, seen.length)), { status: 200 });
  }) as typeof fetch;
  return { seen, restore: () => { globalThis.fetch = real; } };
}

const output = (value: unknown) => ({
  status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
  usage: { input_tokens: 12, output_tokens: 8 },
});

test('GPT_API_KEY selects OpenAI, normalizes strict output, and identifies the provider in the UI', async () => {
  const stub = stubOpenAI(() => output({ fits: true, note: null }));
  const calls = usage.calls;
  try {
    const result = await structured({
      system: 'Check a product.',
      prompt: 'A compact espresso machine.',
      schema: {
        type: 'object',
        properties: { fits: { type: 'boolean' }, note: { type: 'string' } },
        required: ['fits'],
      },
      fast: true,
    });
    assert.deepEqual(result, { fits: true, note: null });
    const body = stub.seen[0];
    assert.equal(body.model, config.openai.fastModel);
    assert.equal(body.store, false);
    assert.equal(body.text.format.strict, true);
    assert.deepEqual(body.text.format.schema.required, ['fits', 'note']);
    assert.deepEqual(body.text.format.schema.properties.note.anyOf, [{ type: 'string' }, { type: 'null' }]);
    assert.equal(usage.calls, calls + 1);
    assert.equal(llmProvider(), 'openai');
    assert.match(describeModes().ai, /^openai:/);
    assert.match(homePage(), /AI: OpenAI/);
  } finally {
    stub.restore();
  }
});

test('OpenAI agent carries reasoning and tool call results into the next request', async () => {
  const reasoning = { type: 'reasoning', id: 'rs_test', summary: [], encrypted_content: 'opaque-test-context' };
  const stub = stubOpenAI((body, step) => {
    if (step === 1) return {
      status: 'completed',
      output: [
        reasoning,
        { type: 'function_call', call_id: 'call_read', name: 'read_stock', arguments: '{"sku":"espresso"}' },
      ],
    };
    assert.deepEqual(body.input.find((item: any) => item.type === 'reasoning'), reasoning);
    assert.deepEqual(body.input.find((item: any) => item.type === 'function_call_output'), {
      type: 'function_call_output', call_id: 'call_read', output: '{"stock":7}',
    });
    return {
      status: 'completed',
      output: [{ type: 'function_call', call_id: 'call_final', name: 'briefing', arguments: '{"notes":"7 available"}' }],
    };
  });
  try {
    const result = await runAgent({
      system: 'Read stock first.',
      prompt: 'Brief the merchant.',
      tools: [{
        name: 'read_stock',
        description: 'Read the available stock.',
        input_schema: { type: 'object', properties: { sku: { type: 'string' } } },
        run: async (input: { sku: string }) => {
          assert.equal(input.sku, 'espresso');
          return { stock: 7 };
        },
      }],
      final: { name: 'briefing', description: 'Return notes.', schema: { type: 'object', properties: { notes: { type: 'string' } } } },
    });
    assert.deepEqual(result.result, { notes: '7 available' });
    assert.deepEqual(result.trace, [{ name: 'read_stock', input: { sku: 'espresso' }, output: '{"stock":7}' }]);
    assert.equal(stub.seen.length, 2);
  } finally {
    stub.restore();
  }
});

test('incomplete and refused OpenAI outputs fall back before parsing partial JSON', async () => {
  const stub = stubOpenAI((_, step) => step === 1
    ? { status: 'incomplete', output: [{ type: 'function_call', arguments: '{' }] }
    : { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] });
  try {
    const options = { system: 's', prompt: 'p', schema: { type: 'object', properties: {} } };
    assert.equal(await structured(options), null);
    assert.equal(await structured(options), null);
  } finally {
    stub.restore();
  }
});

test('seeding a demo uses rules and restores the configured OpenAI key', async () => {
  let calls = 0;
  const stub = stubOpenAI(() => { calls++; throw new Error('Demo seeding must not call OpenAI'); });
  try {
    await seedDemo();
    assert.equal(calls, 0);
    assert.equal(config.openai.apiKey, 'test-openai-key');
  } finally {
    stub.restore();
  }
});
