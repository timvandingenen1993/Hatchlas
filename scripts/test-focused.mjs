import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [file, ...options] = process.argv.slice(2);

// Require a concrete file so a missing filter cannot launch the whole suite.
if (!file || !file.endsWith('.test.ts') || !existsSync(file)) {
  console.error('Choose an existing test file: npm test -- tests/waterRenderer.test.ts');
  console.error('Optionally add -t "test name". Broad checks: npm run test:changed or npm run test:full.');
  process.exit(1);
}

const result = spawnSync(process.execPath, [
  fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)),
  'run', '--config', 'vitest.config.ts', resolve(file), ...options,
], { stdio: 'inherit' });

if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
