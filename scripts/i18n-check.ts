// Checks that every interface string has a Spanish translation.
// Strings are keyed by their English text: t('…') calls in public/*.js and
// elements marked data-t / data-t-html / data-t-placeholder in the page shells.
//
//   npm run i18n:check            list missing translations (exit 1 if any)
//   npm run i18n:check -- --keys  print every key
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const root = join(import.meta.dirname, '..');
const keys = new Set<string>();

// t('…') and t("…") calls in browser scripts.
for (const f of readdirSync(join(root, 'public')).filter((f) => f.endsWith('.js') && f !== 'i18n.js')) {
  const src = readFileSync(join(root, 'public', f), 'utf8');
  for (const m of src.matchAll(/\bt\(\s*'((?:\\.|[^'\\])*)'/g)) keys.add(m[1].replace(/\\'/g, "'"));
  for (const m of src.matchAll(/\bt\(\s*"((?:\\.|[^"\\])*)"/g)) keys.add(m[1].replace(/\\"/g, '"'));
}

// Marked elements in the server-rendered shells.
const pages = readFileSync(join(root, 'src/web/pages.ts'), 'utf8');
for (const m of pages.matchAll(/<(\w+)[^>]*\sdata-t(?:-html)?>([\s\S]*?)<\/\1>/g)) keys.add(m[2].trim());
for (const m of pages.matchAll(/placeholder="([^"]*)"\s+data-t-placeholder/g)) keys.add(m[1]);

// Evaluate the dictionary the same way the browser does.
const sandbox: any = {
  window: {},
  document: { addEventListener() {}, documentElement: {}, querySelectorAll: () => [], getElementById: () => null },
  localStorage: { getItem: () => 'es', setItem() {} },
  navigator: { language: 'es' },
  location: { reload() {}, search: '' },
  URLSearchParams,
};
sandbox.window = sandbox;
vm.runInNewContext(readFileSync(join(root, 'public/i18n.js'), 'utf8'), sandbox);
const dict: Record<string, string> = sandbox.I18N.dictionary;

if (process.argv.includes('--keys')) {
  for (const k of [...keys].sort()) console.log(JSON.stringify(k));
  process.exit(0);
}

const missing = [...keys].filter((k) => !(k in dict));
const unused = Object.keys(dict).filter((k) => !keys.has(k) && !k.startsWith('@'));
const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
const broken = [...keys].filter((k) => k in dict && placeholders(k) !== placeholders(dict[k]));

for (const k of missing) console.log(`missing: ${JSON.stringify(k)}`);
for (const k of broken) console.log(`placeholders differ: ${JSON.stringify(k)} → ${JSON.stringify(dict[k])}`);
if (unused.length) console.log(`note: ${unused.length} unused entries, for example ${JSON.stringify(unused[0])}`);
console.log(`${keys.size} strings, ${missing.length} missing, ${broken.length} with different placeholders.`);
process.exit(missing.length || broken.length ? 1 : 0);
