// control-server.js (kopieer dit en sla op)
import express from 'express';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import bodyParser from 'body-parser';
import crypto from 'crypto';

const app = express();
app.use(bodyParser.json());
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const TOKENS = new Map(); // token -> { discordId }
const AGENTS = new Map(); // token -> { ws, agentId }

wss.on('connection', (ws, req) => {
  const params = new URLSearchParams(req.url.split('?')[1] || '');
  const token = params.get('token');
  const agentId = params.get('agentId') || crypto.randomUUID();
  if (!token || !TOKENS.has(token)) {
    ws.close(4003, 'invalid token');
    return;
  }
  AGENTS.set(token, { ws, agentId, lastSeen: Date.now() });
  ws.on('message', raw => {
    try { const msg = JSON.parse(raw.toString()); if (msg.type === 'assign_result') console.log('agent result', msg); } catch(e){}
  });
  ws.on('close', ()=> AGENTS.delete(token));
});

app.post('/create-token', (req,res) => {
  const { discordId } = req.body;
  if (!discordId) return res.status(400).json({ error: 'discordId required' });
  const token = crypto.randomBytes(24).toString('hex');
  TOKENS.set(token, { discordId, createdAt: Date.now() });
  res.json({ token, exampleAgentCommand: `AGENT_TOKEN=${token} node agent.js` });
});

app.post('/assign-proxy', (req,res) => {
  const { token, filters } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });
  const agent = AGENTS.get(token);
  if (!agent) return res.status(404).json({ error: 'agent offline' });
  try { agent.ws.send(JSON.stringify({ type: 'assign_proxy', filters: filters||{} })); res.json({ ok:true }); }
  catch(e){ res.status(500).json({ error: e.message }); }
});

app.get('/agents', (req,res) => res.json([...AGENTS.entries()].map(([t,i])=>({ token:t, agentId:i.agentId, lastSeen:i.lastSeen }))));

server.listen(3000, ()=> console.log('Control server listening on :3000'));
