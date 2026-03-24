// ─────────────────────────────────────────────
//  Command Central Sync API
//  Stores project data and session logs.
//  Deployed on Railway — free tier.
// ─────────────────────────────────────────────

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Auth ──
// Set SYNC_SECRET as a Railway environment variable
const SECRET = process.env.SYNC_SECRET || 'change-me-in-railway-env';

// ── Data file (Railway persists /data between deploys on Hobby+)
// For free tier, we keep data in memory + a JSON file
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
try {
if (fs.existsSync(DATA_FILE)) {
return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
} catch(e) { console.error('Load error:', e.message); }
return defaultData();
}
function saveData(data) {
try {
fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
} catch(e) { console.error('Save error:', e.message); }
}

function defaultData() {
return {
lastUpdated: new Date().toISOString(),
projects: [
{
id: 1,
name: 'Command Central',
description: 'Personal productivity hub — live Gmail, Calendar, Drive, Tasks & AI assistant.',
status: 'active',
updated: 'Today',
links: [
{ label: 'Live app', url: 'https://mackeyaustin18-afk.github.io/command-central/', type: 'deploy' },
{ label: 'GitHub', url: 'https://github.com/mackeyaustin18-afk/command-central', type: 'github' }
],
color: '#5b4fe8',
initials: 'CC',
log: [
{
date: new Date().toISOString(),
summary: 'Built full live app with Google OAuth, Gmail, Calendar, Drive sync. Deployed to GitHub Pages.',
outputs: ['index.html', 'app.js', 'config.js'],
nextSteps: ['Complete Google Cloud OAuth setup', 'Add Client ID to config.js']
}
]
},
{
id: 2,
name: 'Open Claw',
description: 'In progress — add notes and links once underway.',
status: 'in-progress',
updated: 'Starting soon',
links: [],
color: '#1a9e75',
initials: 'OC',
log: []
},
{
id: 3,
name: 'attractive-mindfulness',
description: 'Railway project — build failing on lead-extractor service.',
status: 'in-progress',
updated: 'Yesterday',
links: [
{ label: 'Railway', url: 'https://railway.app', type: 'deploy' }
],
color: '#d85a30',
initials: 'AM',
log: [
{
date: new Date().toISOString(),
summary: 'Build failed for lead-extractor service. Flagged in Gmail.',
outputs: [],
nextSteps: ['Check Railway build logs', 'Fix lead-extractor service']
}
]
}
],
tasks: [],
meta: {
owner: 'Austin',
githubPages: 'https://mackeyaustin18-afk.github.io/command-central/'
}
};
}
// ── Middleware ──
app.use(cors({
origin: [
'https://mackeyaustin18-afk.github.io',
'http://localhost:3000',
'http://127.0.0.1:5500'
]
}));
app.use(express.json());

// ── Auth middleware (write endpoints only) ──
function requireAuth(req, res, next) {
const key = req.headers['x-sync-key'] || req.query.key;
if (key !== SECRET) {
return res.status(401).json({ error: 'Unauthorized. Provide x-sync-key header.' });
}
next();
}

// ─────────────────────────────────────────────
//  READ endpoints (public — no auth needed)
// ─────────────────────────────────────────────

// GET /  — health check
app.get('/', (req, res) => {
res.json({ status: 'ok', service: 'Command Central Sync API', version: '1.0' });
});

// GET /projects  — get all projects + logs
app.get('/projects', (req, res) => {
const data = loadData();
res.json({
lastUpdated: data.lastUpdated,
projects: data.projects,
meta: data.meta
});
});
// GET /projects/:id  — get single project with full log
app.get('/projects/:id', (req, res) => {
const data = loadData();
const project = data.projects.find(p => p.id === parseInt(req.params.id));
if (!project) return res.status(404).json({ error: 'Project not found' });
res.json(project);
});

// GET /log  — get all session logs across all projects
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

// ─────────────────────────────────────────────
//  WRITE endpoints (require x-sync-key header)
// ─────────────────────────────────────────────

// POST /sync  — push a full project + session log update (used by Claude)
// Body: { projects: [...], sessionLog: { projectId, summary, outputs, nextSteps } }
app.post('/sync', requireAuth, (req, res) => {
const data = loadData();
const { projects, sessionLog } = req.body;
if (projects) {
// Merge updated projects — preserve existing logs
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
summary,
outputs: outputs || [],
nextSteps: nextSteps || []
});
// Keep last 20 log entries per project
project.log = project.log.slice(0, 20);
project.updated = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
}

data.lastUpdated = new Date().toISOString();
saveData(data);
res.json({ ok: true, lastUpdated: data.lastUpdated, projectCount: data.projects.length });
});
// PUT /projects/:id  — update a single project's fields
app.put('/projects/:id', requireAuth, (req, res) => {
const data = loadData();
const idx = data.projects.findIndex(p => p.id === parseInt(req.params.id));
if (idx < 0) return res.status(404).json({ error: 'Project not found' });

const allowed = ['name', 'description', 'status', 'links', 'color', 'initials', 'updated'];
allowed.forEach(key => {
if (req.body[key] !== undefined) data.projects[idx][key] = req.body[key];
});
data.lastUpdated = new Date().toISOString();
saveData(data);
res.json({ ok: true, project: data.projects[idx] });
});

// POST /projects  — add a new project
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

// DELETE /projects/:id
app.delete('/projects/:id', requireAuth, (req, res) => {
const data = loadData();
const idx = data.projects.findIndex(p => p.id === parseInt(req.params.id));
if (idx < 0) return res.status(404).json({ error: 'Project not found' });
const removed = data.projects.splice(idx, 1)[0];
data.lastUpdated = new Date().toISOString();
saveData(data);
res.json({ ok: true, removed: removed.name });
});

// ── Start ──
app.listen(PORT, () => {
console.log(`Command Central Sync API running on port ${PORT}`);
console.log(`Data file: ${DATA_FILE}`);
});