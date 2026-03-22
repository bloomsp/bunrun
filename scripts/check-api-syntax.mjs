import { build } from 'esbuild';
import fg from 'fast-glob';

const files = await fg(['src/pages/api/**/*.ts'], { dot: false });

let ok = true;
for (const file of files) {
  try {
    await build({
      entryPoints: [file],
      bundle: false,
      write: false,
      logLevel: 'silent',
      format: 'esm',
      platform: 'neutral',
      loader: { '.ts': 'ts' },
    });
    process.stdout.write(`OK  ${file}\n`);
  } catch (e) {
    ok = false;
    process.stdout.write(`BAD ${file}\n`);
    // esbuild errors are in e.errors
    if (e?.errors) {
      for (const er of e.errors.slice(0, 8)) {
        process.stdout.write(`  ${er.text} @ ${er.location?.file}:${er.location?.line}:${er.location?.column}\n`);
      }
    } else {
      process.stdout.write(String(e) + '\n');
    }
  }
}

process.exit(ok ? 0 : 1);
