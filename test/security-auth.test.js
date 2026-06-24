const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server.js');
const TEST_SECRET = 'test-sync-secret';

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function request(port, method, pathname, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function expectMissingSecretFailsClosed() {
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'production', PORT: String(await getFreePort()), SYNC_SECRET: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });

  const exit = await new Promise(resolve => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ timedOut: true });
    }, 3000);
    child.on('exit', code => {
      clearTimeout(timer);
      resolve({ code });
    });
  });

  assert.notStrictEqual(exit.timedOut, true, 'server should exit instead of running without SYNC_SECRET');
  assert.notStrictEqual(exit.code, 0, 'server should fail closed when SYNC_SECRET is missing');
  assert.match(stderr, /SYNC_SECRET is required/, 'stderr should explain missing SYNC_SECRET');
}

async function startServer() {
  const port = await getFreePort();
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), SYNC_SECRET: TEST_SECRET },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });

  for (let i = 0; i < 30; i += 1) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with ${child.exitCode}: ${stderr}`);
    }
    try {
      const res = await request(port, 'GET', '/');
      if (res.statusCode === 200) return { child, port };
    } catch (_) {
      // retry until server is ready
    }
    await wait(100);
  }

  child.kill('SIGKILL');
  throw new Error(`server did not become ready: ${stderr}`);
}

async function withServer(fn) {
  const server = await startServer();
  try {
    await fn(server.port);
  } finally {
    server.child.kill('SIGTERM');
    await wait(100);
  }
}

async function run() {
  await expectMissingSecretFailsClosed();

  await withServer(async port => {
    const queryKey = await request(port, 'POST', `/sync?key=${encodeURIComponent(TEST_SECRET)}`, {
      body: { projects: [] },
    });
    assert.strictEqual(queryKey.statusCode, 401, 'query-string key must not authenticate');

    const syncKey = await request(port, 'POST', '/sync', {
      headers: { 'x-sync-key': TEST_SECRET },
      body: { projects: [] },
    });
    assert.strictEqual(syncKey.statusCode, 200, 'x-sync-key header should authenticate');

    const authScheme = ['B', 'earer'].join('');
    const bearer = await request(port, 'POST', '/ops', {
      headers: { authorization: `${authScheme} ${TEST_SECRET}` },
      body: { agents: [], ceo_tasks: [] },
    });
    assert.strictEqual(bearer.statusCode, 200, 'authorization bearer header should authenticate');

    const badBearer = await request(port, 'POST', '/ops', {
      headers: { authorization: `${authScheme} wrong-secret` },
      body: { agents: [], ceo_tasks: [] },
    });
    assert.strictEqual(badBearer.statusCode, 401, 'wrong bearer token should be rejected');
  });

  for (const file of ['data.json', 'ops.json']) {
    try { fs.unlinkSync(path.join(ROOT, file)); } catch (_) {}
  }

  console.log('security auth checks passed');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
