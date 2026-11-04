import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessCategory, parseDeadline, parsePrice, heuristicParse } from '../src/ai/intent.ts';
import { cosine, localEmbed } from '../src/ai/embed.ts';

test('parsePrice understands English and Spanish', () => {
  assert.equal(parsePrice('espresso machine under $200'), 200);
  assert.equal(parsePrice('menos de 150 dólares'), 150);
  assert.equal(parsePrice('máximo $1,200 please'), 1200);
  assert.equal(parsePrice('hasta 99.50 usd'), 99.5);
  assert.equal(parsePrice('a nice tent'), null);
});

test('parseDeadline handles months and relative dates', () => {
  const now = new Date('2026-11-02T12:00:00Z');
  assert.equal(parseDeadline('before December', now), '2026-12-01');
  assert.equal(parseDeadline('antes de marzo', now), '2027-03-01');
  assert.equal(parseDeadline('in 2 weeks', now), '2026-11-16');
  assert.equal(parseDeadline('no rush', now), null);
});

test('guessCategory', () => {
  assert.equal(guessCategory('Cafetera espresso compacta'), 'coffee');
  assert.equal(guessCategory('carpa ultraligera para 2'), 'outdoor');
  assert.equal(guessCategory('noise cancelling headphones'), 'audio');
});

test('local embeddings put Spanish and English for the same product close together', () => {
  const es = localEmbed(heuristicParse('Cafetera espresso compacta para dos').product_query);
  const en = localEmbed('Compact espresso machine coffee maker');
  const tent = localEmbed('Ultralight 2-person backpacking tent');
  assert.ok(cosine(es, en) > cosine(es, tent) + 0.2, `${cosine(es, en)} vs ${cosine(es, tent)}`);
});
