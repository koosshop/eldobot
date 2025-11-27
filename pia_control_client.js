// pia_control_client.js
// Simpele clientmodule om met de control-server te praten.
// Gebruikt node-fetch v2 (compatibel met je package.json).

const fetch = require('node-fetch');
require('dotenv').config();

const CONTROL_SERVER = process.env.CONTROL_SERVER || 'http://localhost:3000';
const CONTROL_API_KEY = process.env.CONTROL_API_KEY || ''; // optioneel

function authHeaders() {
  const h = { 'content-type': 'application/json' };
  if (CONTROL_API_KEY) h['authorization'] = `Bearer ${CONTROL_API_KEY}`;
  return h;
}

async function createTokenForDiscordUser(discordId) {
  const res = await fetch(`${CONTROL_SERVER}/create-token`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ discordId })
  });
  return res.json();
}

async function assignProxyByToken(token, filters = {}) {
  const res = await fetch(`${CONTROL_SERVER}/assign-proxy`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ token, filters })
  });
  return res.json();
}

async function listAgents() {
  const res = await fetch(`${CONTROL_SERVER}/agents`, { headers: authHeaders() });
  return res.json();
}

module.exports = {
  createTokenForDiscordUser,
  assignProxyByToken,
  listAgents
};
