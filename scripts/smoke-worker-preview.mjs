import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const wranglerConfig = path.join(root, 'dist', 'server', 'wrangler.json');
const port = Number(process.env.SMOKE_PORT || 8788);
const host = '127.0.0.1';
const baseUrl = `http://${host}:${port}`;
const viewPassword = process.env.BUNRUN_VIEW_PASSWORD || 'ci-view-password';
const adminPassword = process.env.BUNRUN_ADMIN_PASSWORD || 'ci-admin-password';
const envFile = path.join(root, 'dist', 'server', '.ci-smoke.vars');

if (!fs.existsSync(wranglerConfig)) {
  console.error(`Missing ${wranglerConfig}. Run npm run build and npm run prepare:worker-preview first.`);
  process.exit(1);
}

fs.writeFileSync(
  envFile,
  `BUNRUN_VIEW_PASSWORD=${viewPassword}\nBUNRUN_ADMIN_PASSWORD=${adminPassword}\n`,
  { mode: 0o600 },
);

const wranglerBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
const command = fs.existsSync(wranglerBin) ? wranglerBin : 'wrangler';
const args = [
  'dev',
  '--config',
  wranglerConfig,
  '--ip',
  host,
  '--port',
  String(port),
  '--local',
  '--env-file',
  envFile,
  '--log-level',
  'warn',
];

const child = spawn(command, args, {
  cwd: path.join(root, 'dist', 'server'),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NO_COLOR: '1' },
});

let output = '';
child.stdout.on('data', (chunk) => {
  output += chunk.toString();
});
child.stderr.on('data', (chunk) => {
  output += chunk.toString();
});

function stopServer() {
  if (!child.killed) child.kill('SIGTERM');
}

async function waitForServer() {
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < 30_000) {
    if (child.exitCode !== null) {
      throw new Error(`wrangler dev exited early with code ${child.exitCode}\n${output}`);
    }

    try {
      const response = await fetch(baseUrl, { redirect: 'manual' });
      if (response.status === 200) return;
      lastError = new Error(`Unexpected status while waiting: ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for ${baseUrl}: ${lastError?.message || 'unknown error'}\n${output}`);
}

async function expectGet(pathname, expectedText) {
  const response = await fetch(`${baseUrl}${pathname}`, { redirect: 'manual' });
  const text = await response.text();
  if (response.status !== 200) {
    throw new Error(`GET ${pathname} expected 200, got ${response.status}: ${text.slice(0, 300)}`);
  }
  if (expectedText && !text.includes(expectedText)) {
    throw new Error(`GET ${pathname} did not include expected text: ${expectedText}`);
  }
  console.log(`✓ GET ${pathname} returned 200`);
}

async function expectLoginFailure() {
  const body = new URLSearchParams({ role: 'admin', password: 'definitely-wrong' });
  const response = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: baseUrl },
    body,
    redirect: 'manual',
  });
  if (response.status !== 401) {
    throw new Error(`POST /api/login with wrong password expected 401, got ${response.status}`);
  }
  console.log('✓ POST /api/login rejects bad credentials');
}

async function expectAdminLoginRedirect() {
  const body = new URLSearchParams({ role: 'admin', password: adminPassword });
  const response = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: baseUrl },
    body,
    redirect: 'manual',
  });
  const location = response.headers.get('location');
  const setCookie = response.headers.get('set-cookie') || '';
  if (response.status !== 303 || location !== '/admin') {
    throw new Error(`POST /api/login expected 303 redirect to /admin, got ${response.status} location=${location}`);
  }
  if (!setCookie.includes('bunrun_role=')) {
    throw new Error('POST /api/login did not set the role cookie');
  }
  console.log('✓ POST /api/login accepts admin credentials and redirects');
}

try {
  await waitForServer();
  await expectGet('/', 'Bunrun');
  await expectGet('/login/', 'Choose a login type');
  await expectLoginFailure();
  await expectAdminLoginRedirect();
  console.log('Worker deploy smoke checks passed.');
} catch (error) {
  console.error(error.stack || error.message || error);
  console.error('\nwrangler output:\n' + output);
  process.exitCode = 1;
} finally {
  stopServer();
  try {
    fs.rmSync(envFile, { force: true });
  } catch {
    // ignore cleanup errors
  }
}
