// ─────────────────────────────────────────────────────────────────────────────
// CC-SYNC-API SERVER.JS — FULL PATCHED VERSION
// Adds GET /ops and POST /ops to the existing project sync API.
// Deploy this as server.js in the cc-sync-api Railway repo.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const helmet  = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { z }   = require('zod');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

function readRequiredSecret(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    console.error(`${name} is required; refusing to start without an explicit sync secret.`);
    process.exit(1);
  }
  return value;
}

const SECRET   = readRequiredSecret('SYNC_SECRET');
const DATA_FILE = path.resolve(process.env.DATA_FILE || path.join(__dirname, 'data.json'));
const OPS_FILE  = path.resolve(process.env.OPS_FILE || path.join(__dirname, 'ops.json'));

// ── Data helpers ──────────────────────────────────────────────────────────────
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch(e) { console.error('Load error:', e.message); }
  return defaultData();
}
function saveData(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }
  catch(e) { console.error('Save error:', e.message); }
}

// ── Ops helpers (NEW) ─────────────────────────────────────────────────────────
function loadOps() {
  try {
    if (fs.existsSync(OPS_FILE)) return JSON.parse(fs.readFileSync(OPS_FILE, 'utf8'));
  } catch(e) { console.error('Ops load error:', e.message); }
  return { generated_at: null, agents: [], ceo_tasks: [] };
}
function saveOps(data) {
  try { fs.writeFileSync(OPS_FILE, JSON.stringify(data, null, 2)); }
  catch(e) { console.error('Ops save error:', e.message); }
}

function defaultData() {
  return {
    lastUpdated: new Date().toISOString(),
    projects: [
      {
        id: 1, name: 'Command Central',
        description: 'Personal productivity hub — live Gmail, Calendar, Drive, Tasks & AI assistant.',
        status: 'active', updated: 'Today',
        links: [
          { label: 'Live app', url: 'https://mackeyaustin18-afk.github.io/command-central/', type: 'deploy' },
          { label: 'GitHub', url: 'https://github.com/mackeyaustin18-afk/command-central', type: 'github' }
        ],
        color: '#5b4fe8', initials: 'CC', log: []
      },
      {
        id: 2, name: 'PawZen', description: 'Shopify pet wellness store — PawZen brand.',
        status: 'active', updated: 'Today',
        links: [{ label: 'Shopify', url: 'https://pawzen.myshopify.com', type: 'deploy' }],
        color: '#1a9e75', initials: 'PZ', log: []
      }
    ],
    tasks: [],
    meta: { owner: 'Austin', githubPages: 'https://mackeyaustin18-afk.github.io/command-central/' }
  };
}

// ── Validation and sanitization ───────────────────────────────────────────────
const linkSchema = z.object({
  label: z.string().max(120),
  url: z.string().max(2048),
  type: z.string().max(40).optional(),
}).strip();

const projectFieldsSchema = z.object({
  name: z.string().max(120).optional(),
  description: z.string().max(2000).optional(),
  status: z.string().max(40).optional(),
  links: z.array(linkSchema).max(20).optional(),
  color: z.string().max(20).optional(),
  initials: z.string().max(8).optional(),
  updated: z.string().max(80).optional(),
}).strip();

const syncProjectSchema = projectFieldsSchema.extend({
  id: z.number().int().positive(),
}).strip();

const sessionLogSchema = z.object({
  projectId: z.number().int().positive(),
  summary: z.string().max(2000),
  outputs: z.array(z.string().max(500)).max(50).optional(),
  nextSteps: z.array(z.string().max(500)).max(50).optional(),
}).strip();

const syncSchema = z.object({
  projects: z.array(syncProjectSchema).max(100).optional(),
  sessionLog: sessionLogSchema.optional(),
}).strict().refine(
  body => body.projects !== undefined || body.sessionLog !== undefined,
  { message: 'projects or sessionLog is required' },
);

const createProjectSchema = projectFieldsSchema.strict();
const updateProjectSchema = projectFieldsSchema.strict().refine(
  body => Object.keys(body).length > 0,
  { message: 'at least one project field is required' },
);

const opsSchema = z.object({
  generated_at: z.string().max(80).optional(),
  agents: z.array(z.record(z.unknown())).max(200),
  ceo_tasks: z.array(z.record(z.unknown())).max(500).optional(),
}).strict();

function cleanText(value, maxLength = 2000) {
  return value
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, maxLength);
}

function safeHttpsUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch (_) {
    return null;
  }
}

function sanitizeLink(link) {
  const url = safeHttpsUrl(link.url);
  if (!url) return null;
  return {
    label: cleanText(link.label, 120),
    url,
    ...(link.type ? { type: cleanText(link.type, 40) } : {}),
  };
}

function sanitizeProjectFields(project) {
  const sanitized = {};
  if (project.id !== undefined) sanitized.id = project.id;
  if (project.name !== undefined) sanitized.name = cleanText(project.name, 120);
  if (project.description !== undefined) sanitized.description = cleanText(project.description, 2000);
  if (project.status !== undefined) sanitized.status = cleanText(project.status, 40);
  if (project.links !== undefined) sanitized.links = project.links.map(sanitizeLink).filter(Boolean);
  if (project.color !== undefined) sanitized.color = /^#[0-9a-f]{6}$/i.test(project.color) ? project.color : '#5b4fe8';
  if (project.initials !== undefined) sanitized.initials = cleanText(project.initials, 8);
  if (project.updated !== undefined) sanitized.updated = cleanText(project.updated, 80);
  return sanitized;
}

function sanitizeStructuredValue(value, depth = 0) {
  if (depth > 5) return null;
  if (typeof value === 'string') return cleanText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 200).map(item => sanitizeStructuredValue(item, depth + 1));
  if (value && typeof value === 'object') {
    const sanitized = {};
    for (const [rawKey, rawValue] of Object.entries(value).slice(0, 100)) {
      const key = cleanText(rawKey, 64);
      if (!key) continue;
      if (typeof rawValue === 'string' && /(?:url|href)$/i.test(key)) {
        const url = safeHttpsUrl(rawValue);
        if (url) sanitized[key] = url;
        continue;
      }
      sanitized[key] = sanitizeStructuredValue(rawValue, depth + 1);
    }
    return sanitized;
  }
  return null;
}

function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) return res.status(400).json({ error: 'Invalid request body' });
    req.validatedBody = result.data;
    next();
  };
}

// ── Middleware ─────────────────────────────────────────────────────────────────
app.disable('x-powered-by');
// Railway terminates traffic at one ingress proxy. Trust exactly that hop so
// rate-limit keys use the real client address without trusting leftmost XFF data.
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({
  origin: [
    'https://mackeyaustin18-afk.github.io',
    'http://localhost:3000',
    'http://127.0.0.1:5500',
    'http://localhost:5500',
  ]
}));
app.use(express.json({ limit: '32kb' }));

const configuredRateLimit = Number.parseInt(process.env.RATE_LIMIT_MAX || '120', 10);
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number.isInteger(configuredRateLimit) && configuredRateLimit > 0 ? configuredRateLimit : 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
app.use(['/projects', '/log', '/sync', '/ops'], apiLimiter);

function extractAuthSecret(req) {
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string') {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1];
  }

  const syncKey = req.headers['x-sync-key'];
  if (Array.isArray(syncKey)) return syncKey[0];
  return syncKey;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireAuth(req, res, next) {
  const key = extractAuthSecret(req);
  if (!safeEqual(key, SECRET)) {
    return res.status(401).json({ error: 'Unauthorized. Provide a bearer credential or x-sync-key header.' });
  }
  res.set('Cache-Control', 'no-store');
  next();
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Command Central Sync API', version: '1.1' });
});

// ── Projects (existing) ────────────────────────────────────────────────────────
app.get('/projects', requireAuth, (req, res) => {
  const data = loadData();
  res.json({ lastUpdated: data.lastUpdated, projects: data.projects, meta: data.meta });
});

app.get('/projects/:id', requireAuth, (req, res) => {
  const data = loadData();
  const project = data.projects.find(p => p.id === parseInt(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(project);
});

app.get('/log', requireAuth, (req, res) => {
  const data = loadData();
  const allLogs = [];
  data.projects.forEach(p => {
    (p.log || []).forEach(entry => {
      allLogs.push({ project: p.name, projectId: p.id, color: p.color, ...entry });
    });
  });
  allLogs.sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json({ logs: allLogs });
});

app.post('/sync', requireAuth, validateBody(syncSchema), (req, res) => {
  const data = loadData();
  const { projects, sessionLog } = req.validatedBody;
  if (projects) {
    projects.forEach(incoming => {
      const sanitizedIncoming = sanitizeProjectFields(incoming);
      const idx = data.projects.findIndex(p => p.id === incoming.id);
      if (idx >= 0) {
        data.projects[idx] = { ...data.projects[idx], ...sanitizedIncoming, log: data.projects[idx].log };
      } else {
        data.projects.push({ ...sanitizedIncoming, log: [] });
      }
    });
  }
  if (sessionLog) {
    const { projectId, summary, outputs, nextSteps } = sessionLog;
    const project = data.projects.find(p => p.id === projectId);
    if (project) {
      if (!project.log) project.log = [];
      project.log.unshift({
        date: new Date().toISOString(),
        summary: cleanText(summary, 2000),
        outputs: (outputs || []).map(value => cleanText(value, 500)),
        nextSteps: (nextSteps || []).map(value => cleanText(value, 500)),
      });
      project.log = project.log.slice(0, 20);
      project.updated = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
  }
  data.lastUpdated = new Date().toISOString();
  saveData(data);
  res.json({ ok: true, lastUpdated: data.lastUpdated, projectCount: data.projects.length });
});

app.put('/projects/:id', requireAuth, validateBody(updateProjectSchema), (req, res) => {
  const data = loadData();
  const idx = data.projects.findIndex(p => p.id === parseInt(req.params.id));
  if (idx < 0) return res.status(404).json({ error: 'Project not found' });
  Object.assign(data.projects[idx], sanitizeProjectFields(req.validatedBody));
  data.lastUpdated = new Date().toISOString();
  saveData(data);
  res.json({ ok: true, project: data.projects[idx] });
});

app.post('/projects', requireAuth, validateBody(createProjectSchema), (req, res) => {
  const data = loadData();
  const maxId = data.projects.reduce((m, p) => Math.max(m, p.id), 0);
  const incoming = sanitizeProjectFields(req.validatedBody);
  const project = {
    id: maxId + 1,
    name: incoming.name || 'New Project',
    description: incoming.description || '',
    status: incoming.status || 'active',
    updated: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    links: incoming.links || [],
    color: incoming.color || '#5b4fe8',
    initials: incoming.initials || (incoming.name || 'NP').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2),
    log: []
  };
  data.projects.push(project);
  data.lastUpdated = new Date().toISOString();
  saveData(data);
  res.status(201).json({ ok: true, project });
});

app.delete('/projects/:id', requireAuth, (req, res) => {
  const data = loadData();
  const idx = data.projects.findIndex(p => p.id === parseInt(req.params.id));
  if (idx < 0) return res.status(404).json({ error: 'Project not found' });
  const removed = data.projects.splice(idx, 1)[0];
  data.lastUpdated = new Date().toISOString();
  saveData(data);
  res.json({ ok: true, removed: removed.name });
});

// ── Agent Ops Board (NEW) ──────────────────────────────────────────────────────

// GET /ops — authenticated internal read
app.get('/ops', requireAuth, (req, res) => {
  const ops = loadOps();
  res.json(ops);
});

// POST /ops — authenticated push from Brain node (refresh_agent_operations_board.js)
app.post('/ops', requireAuth, validateBody(opsSchema), (req, res) => {
  const { generated_at, agents, ceo_tasks } = req.validatedBody;
  const ops = {
    generated_at: generated_at ? cleanText(generated_at, 80) : new Date().toISOString(),
    agents: agents.map(agent => sanitizeStructuredValue(agent)),
    ceo_tasks: (ceo_tasks || []).map(task => sanitizeStructuredValue(task)),
  };
  saveOps(ops);
  res.json({ ok: true, generated_at: ops.generated_at, agent_count: ops.agents.length, task_count: ops.ceo_tasks.length });
});

app.use((error, req, res, next) => {
  if (error && error.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  next(error);
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Command Central Sync API v1.1 running on port ${PORT}`);
  console.log(`Data: ${DATA_FILE} | Ops: ${OPS_FILE}`);
});
