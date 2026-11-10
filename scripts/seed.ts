// Demo data: two fictional merchants, a catalog, two open groups and some
// waiting demand (see src/demo.ts).
//
//   npm run seed            add demo data to the database
//   npm run seed -- --reset delete the database first
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { seedDemo } from '../src/demo.ts';

if (process.argv.includes('--reset')) {
  const file = config.dbFile || join(config.dataDir, 'quorum.db');
  for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });
  console.log('Database reset.');
}
openDb();

const { groupA, groupB } = await seedDemo({ llm: process.argv.includes('--llm') });

console.log('Seeded demo data:');
console.log(`  Group A (4 of 5, espresso):  ${config.baseUrl}/q/${groupA.id}`);
console.log(`  Group B (2 of 5, expiring):  ${config.baseUrl}/q/${groupB.id}`);
console.log(`  Merchant console:            ${config.baseUrl}/merchant`);
