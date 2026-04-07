import { mkdir, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const testsDir = path.join(root, 'tests');
const outDir = path.join(root, '.tmp-tests');

const entries = (await readdir(testsDir))
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => ({
    in: path.join(testsDir, name),
    out: path.join(outDir, name.replace(/\.ts$/, '.mjs'))
  }));

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await Promise.all(entries.map((entry) =>
  build({
    entryPoints: [entry.in],
    outfile: entry.out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: 'inline'
  })
));

const code = await new Promise((resolve) => {
  const child = spawn(process.execPath, ['--test', ...entries.map((entry) => entry.out)], {
    cwd: root,
    stdio: 'inherit'
  });
  child.on('exit', (exitCode) => resolve(exitCode ?? 1));
});

process.exit(code);
