// ─────────────────────────────────────────────────────────────────────────────
// CC-SYNC-API SERVER.JS — FULL PATCHED VERSION
// Adds GET /ops and POST /ops to the existing project sync API.
// Deploy this as server.js in the cc-sync-api Railway repo.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const SECRET   = process.env.SYNC_SECRET || 'change-me-in-railway-env';
const DATA_FILE = path.join(__dirname, 'data.json');
const OPS_FILE  = path.join(__dirname, 'ops.json');   // ← NEW: agent ops board

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

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    'https://mackeyaustin18-afk.github.io',
    'http://localhost:3000',
    'http://127.0.0.1:5500',
    'http://localhost:5500',
  ]
}));
app.use(express.json());

function requireAuth(req, res, next) {
  const key = req.headers['x-sync-key'] || req.query.key;
  if (key !== SECRET) return res.status(401).json({ error: 'Unauthorized. Provide x-sync-key header.' });
  next();
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Command Central Sync API', version: '1.1' });
});

// ── Projects (existing) ────────────────────────────────────────────────────────
app.get('/projects', (req, res) => {
  const data = loadData();
  res.json({ lastUpdated: data.lastUpdated, projects: data.projects, meta: data.meta });
});

app.get('/projects/:id', (req, res) => {
  const data = loadData();
  const project = data.projects.find(p => p.id === parseInt(req.params.id));
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(project);
});

app.get('/log', (req, res) => {
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

app.post('/sync', requireAuth, (req, res) => {
  const data = loadData();
  const { projects, sessionLog } = req.body;
  if (projects) {
    projects.forEach(incoming => {
      const idx = data.projects.findIndex(p => p.id === incoming.id);
      if (idx >= 0) {
        data.projects[idx] = { ...data.projects[idx], ...incoming, log: data.projects[idx].log };
      } else {
        data.projects.push({ ...incoming, log: [] });
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
        summary, outputs: outputs || [], nextSteps: nextSteps || []
      });
      project.log = project.log.slice(0, 20);
      project.updated = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
  }
  data.lastUpdated = new Date().toISOString();
  saveData(data);
  res.json({ ok: true, lastUpdated: data.lastUpdated, projectCount: data.projects.length });
});

app.put('/projects/:id', requireAuth, (req, res) => {
  const data = loadData();
  const idx = data.projects.findIndex(p => p.id === parseInt(req.params.id));
  if (idx < 0) return res.status(404).json({ error: 'Project not found' });
  const allowed = ['name', 'description', 'status', 'links', 'color', 'initials', 'updated'];
  allowed.forEach(key => { if (req.body[key] !== undefined) data.projects[idx][key] = req.body[key]; });
  data.lastUpdated = new Date().toISOString();
  saveData(data);
  res.json({ ok: true, project: data.projects[idx] });
});

app.post('/projects', requireAuth, (req, res) => {
  const data = loadData();
  const maxId = data.projects.reduce((m, p) => Math.max(m, p.id), 0);
  const project = {
    id: maxId + 1,
    name: req.body.name || 'New Project',
    description: req.body.description || '',
    status: req.body.status || 'active',
    updated: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    links: req.body.links || [],
    color: req.body.color || '#5b4fe8',
    initials: req.body.initials || (req.body.name||'NP').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2),
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

// GET /ops — public read; used by Command Central dashboard
app.get('/ops', (req, res) => {
  const ops = loadOps();
  res.json(ops);
});

// POST /ops — authenticated push from Brain node (refresh_agent_operations_board.js)
app.post('/ops', requireAuth, (req, res) => {
  const { generated_at, agents, ceo_tasks } = req.body;
  if (!agents || !Array.isArray(agents)) {
    return res.status(400).json({ error: 'agents array is required' });
  }
  const ops = {
    generated_at: generated_at || new Date().toISOString(),
    agents,
    ceo_tasks: ceo_tasks || [],
  };
  saveOps(ops);
  res.json({ ok: true, generated_at: ops.generated_at, agent_count: agents.length, task_count: ops.ceo_tasks.length });
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Command Central Sync API v1.1 running on port ${PORT}`);
  console.log(`Data: ${DATA_FILE} | Ops: ${OPS_FILE}`);
});
