import express from 'express';
import path from 'path';
import { handleRpc, actionNames } from './rpc.js';

// Action modules register themselves on import.
import './actions/auth.js';
import './actions/profile.js';
import './actions/social.js';
import './actions/push.js';
import './actions/commerce.js';
import './actions/admin.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '12mb' })); // base64 photos/evidence up to 10MB + envelope
// CORS: the API is public and auth travels in the JSON body (never cookies),
// so cross-origin browser calls (e.g. the admin web panel) are safe to allow.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  next();
});
// Minimal access log (method + path + status) for remote debugging.
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => {
    console.log(`[req] ${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - t}ms)`);
  });
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true, actions: actionNames().length }));
app.post('/actions', handleRpc);
// Compatibility: some clients may POST to the root path.
app.post('/', handleRpc);

// Web preview of the VINCÓ app (Flutter web build in ./web). API routes
// above take precedence; this only serves GET /app/* with SPA fallback.
app.use('/app', express.static(path.join(__dirname, '..', 'web'), { index: 'index.html' }));
app.get('/app/*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'web', 'index.html')));

const PORT = parseInt(process.env.PORT ?? '8080', 10);
app.listen(PORT, () => {
  console.log(`vinco-backend listening on :${PORT} — ${actionNames().length} actions registered`);
});