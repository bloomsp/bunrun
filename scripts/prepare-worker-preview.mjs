import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const distServer = path.join(root, 'dist', 'server');
const rootDevVars = path.join(root, '.dev.vars');
const distDevVars = path.join(distServer, '.dev.vars');
const rootMigrations = path.join(root, 'migrations');
const distMigrations = path.join(distServer, 'migrations');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

ensureDir(distServer);
ensureDir(distMigrations);

if (fs.existsSync(rootDevVars)) {
  fs.copyFileSync(rootDevVars, distDevVars);
  console.log('Copied .dev.vars to dist/server/.dev.vars');
} else {
  console.log('No root .dev.vars found, skipping env copy');
}

if (fs.existsSync(rootMigrations)) {
  for (const entry of fs.readdirSync(rootMigrations)) {
    if (!entry.endsWith('.sql')) continue;
    fs.copyFileSync(path.join(rootMigrations, entry), path.join(distMigrations, entry));
  }
  console.log('Copied migrations to dist/server/migrations');
} else {
  console.log('No migrations directory found, skipping migration copy');
}
