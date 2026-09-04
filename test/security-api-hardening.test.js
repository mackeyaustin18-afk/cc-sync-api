const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server.js');
const TEST_CREDENTIAL = 'test-api-hardening-secret';

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

function request(port, method, pathname, { headers = {}, body, rawBody } = {}) {
  return new Promise((resolve, reject) => {
    const payload = rawBody !== undefined
      ? rawBody
      : body !== undefined
        ? JSON.stringify(body)
        : undefined;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        ...(payload !== undefined
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : {}),
        ...headers,
      },
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: data,
      }));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function startServer(extraEnv = {}) {
  const port = await getFreePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sync-api-test-'));
  const dataFile = path.join(tempDir, 'data.json');
  const opsFile = path.join(tempDir, 'ops.json');
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      SYNC_SECRET: TEST_CREDENTIAL,
      DATA_FILE: dataFile,
      OPS_FILE: opsFile,
      ...extraEnv,
    },
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
      if (res.statusCode === 200) return { child, port, tempDir, dataFile, opsFile };
    } catch (_) {
      // retry until server is ready
    }
    await wait(100);
  }

  child.kill('SIGKILL');
  fs.rmSync(tempDir, { recursive: true, force: true });
  throw new Error(`server did not become ready: ${stderr}`);
}

async function withServer(fn, extraEnv = {}) {
  const server = await startServer(extraEnv);
  try {
    await fn(server.port, server);
  } finally {
    server.child.kill('SIGTERM');
    await wait(100);
    fs.rmSync(server.tempDir, { recursive: true, force: true });
  }
}

function authHeaders() {
  return { 'x-sync-key': TEST_CREDENTIAL };
}

function parseJson(response) {
  return JSON.parse(response.body);
}

async function expectInternalReadsRequireAuthAndHelmetIsActive() {
  await withServer(async port => {
    const health = await request(port, 'GET', '/');
    assert.strictEqual(health.statusCode, 200);
    assert.strictEqual(health.headers['x-content-type-options'], 'nosniff');
    assert.ok(health.headers['content-security-policy'], 'Helmet should set a Content-Security-Policy');

    for (const endpoint of ['/projects', '/projects/1', '/log', '/ops']) {
      const anonymous = await request(port, 'GET', endpoint);
      assert.strictEqual(anonymous.statusCode, 401, `${endpoint} must reject anonymous reads`);

      const authenticated = await request(port, 'GET', endpoint, { headers: authHeaders() });
      assert.ok(
        [200, 404].includes(authenticated.statusCode),
        `${endpoint} should reach its handler with valid auth`,
      );
      assert.strictEqual(
        authenticated.headers['cache-control'],
        'no-store',
        `${endpoint} must prevent authenticated operational data from being cached`,
      );
    }
  });
}

async function expectInvalidPayloadsAndOversizedBodiesAreRejected() {
  await withServer(async port => {
    const invalidSync = await request(port, 'POST', '/sync', {
      headers: authHeaders(),
      body: { projects: 'not-an-array' },
    });
    assert.strictEqual(invalidSync.statusCode, 400, 'invalid sync schema must be rejected');

    const invalidOps = await request(port, 'POST', '/ops', {
      headers: authHeaders(),
      body: { agents: [], ceo_tasks: 'not-an-array' },
    });
    assert.strictEqual(invalidOps.statusCode, 400, 'invalid ops schema must be rejected');

    const oversized = await request(port, 'POST', '/ops', {
      headers: authHeaders(),
      rawBody: JSON.stringify({ agents: [], ceo_tasks: [], padding: 'x'.repeat(40 * 1024) }),
    });
    assert.strictEqual(oversized.statusCode, 413, 'JSON payloads over the configured limit must be rejected');
  });
}

async function expectStoredContentIsSanitized() {
  await withServer(async (port, server) => {
    const created = await request(port, 'POST', '/projects', {
      headers: authHeaders(),
      body: {
        name: '<b>Unsafe Project</b>',
        description: '<img src=x onerror=alert(1)>Description',
        status: 'active<script>alert(1)</script>',
        links: [
          { label: '<script>Bad</script>', url: 'javascript:alert(1)', type: 'deploy' },
          { label: 'Safe <b>Link</b>', url: 'https://example.com/path', type: 'deploy' },
        ],
        color: '#123456',
        initials: '<P>',
      },
    });
    assert.strictEqual(created.statusCode, 201);
    assert.ok(fs.existsSync(server.dataFile), 'project data must use the isolated test data file');
    const project = parseJson(created).project;
    assert.doesNotMatch(project.name, /[<>]/);
    assert.doesNotMatch(project.description, /[<>]/);
    assert.doesNotMatch(project.status, /[<>]/);
    assert.doesNotMatch(project.initials, /[<>]/);
    assert.deepStrictEqual(project.links.map(link => link.url), ['https://example.com/path']);
    assert.doesNotMatch(project.links[0].label, /[<>]/);

    const savedOps = await request(port, 'POST', '/ops', {
      headers: authHeaders(),
      body: {
        generated_at: new Date().toISOString(),
        agents: [{ name: '<img src=x onerror=alert(1)>Agent', status: '<script>bad()</script>' }],
        ceo_tasks: [{ title: '<svg onload=alert(1)>Task' }],
      },
    });
    assert.strictEqual(savedOps.statusCode, 200);
    assert.ok(fs.existsSync(server.opsFile), 'ops data must use the isolated test ops file');

    const readOps = await request(port, 'GET', '/ops', { headers: authHeaders() });
    assert.strictEqual(readOps.statusCode, 200);
    const ops = parseJson(readOps);
    assert.doesNotMatch(ops.agents[0].name, /[<>]/);
    assert.doesNotMatch(ops.agents[0].status, /[<>]/);
    assert.doesNotMatch(ops.ceo_tasks[0].title, /[<>]/);
  });
}

async function expectRateLimitIsEnforcedPerProxiedClient() {
  await withServer(async port => {
    const firstClient = { 'x-forwarded-for': '203.0.113.10' };
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const response = await request(port, 'GET', '/projects', { headers: firstClient });
      assert.strictEqual(response.statusCode, 401, `request ${attempt} should reach authentication`);
    }
    const limited = await request(port, 'GET', '/projects', { headers: firstClient });
    assert.strictEqual(limited.statusCode, 429, 'requests over the configured limit must be throttled');

    const secondClient = await request(port, 'GET', '/projects', {
      headers: { 'x-forwarded-for': '203.0.113.11' },
    });
    assert.strictEqual(secondClient.statusCode, 401, 'a different proxied client must receive a separate bucket');

    const spoofedLeftmostAddress = await request(port, 'GET', '/projects', {
      headers: { 'x-forwarded-for': '198.51.100.99, 203.0.113.10' },
    });
    assert.strictEqual(
      spoofedLeftmostAddress.statusCode,
      429,
      'an attacker-controlled leftmost forwarded address must not bypass the real client bucket',
    );
  }, { RATE_LIMIT_MAX: '2' });
}

async function run() {
  await expectInternalReadsRequireAuthAndHelmetIsActive();
  await expectInvalidPayloadsAndOversizedBodiesAreRejected();
  await expectStoredContentIsSanitized();
  await expectRateLimitIsEnforcedPerProxiedClient();

  console.log('security API hardening checks passed');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
