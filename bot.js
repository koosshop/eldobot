// bot.js — complete vervanging (copy-paste)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Client, GatewayIntentBits, SlashCommandBuilder } = require('discord.js');
const { google } = require('googleapis');

// PIA control client (nieuw bestand: pia_control_client.js moet in dezelfde map staan)
const { createTokenForDiscordUser, assignProxyByToken, listAgents } = require('./pia_control_client');

// ---------- CONFIG (houd jouw bestaande Google/SHEET config indien van toepassing) ----------
const CREDENTIALS_PATH = path.join(__dirname, 'google_oauth_credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1iFR1b3FQorkct4klp05DO7-R0XHRMLjmq1nvinoUU2k'; // vervang naar wens
const DEFAULT_CALLBACK_PORT = process.env.PORT || 3000;
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
// ---------------------------------------------------------------------

const TOKEN = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN || null;
if (!TOKEN) {
  console.error('ERROR: Geen Discord token gevonden in environment. Zet DISCORD_TOKEN (of BOT_TOKEN).');
  process.exit(1);
}

// Google auth (optioneel — als je Sheets gebruikt)
let oauth2Client = null;
let sheets = null;
if (fs.existsSync(CREDENTIALS_PATH)) {
  try {
    const rawCreds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const webCreds = rawCreds.web || rawCreds.installed || rawCreds;
    const { client_id, client_secret, redirect_uris } = webCreds;
    oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    sheets = google.sheets({ version: 'v4', auth: oauth2Client });
  } catch (err) {
    console.warn('Fout bij inlezen google_oauth_credentials.json:', err.message || err);
  }
}

async function ensureAuthenticated() {
  if (!oauth2Client) {
    throw new Error('OAuth2 client niet geconfigureerd (google_oauth_credentials.json missen).');
  }
  if (fs.existsSync(TOKEN_PATH)) {
    try {
      const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
      oauth2Client.setCredentials(token);
      return;
    } catch (e) {
      console.warn('Kon token.json niet lezen, open de URL om te autoriseren (zie console).', e.message || e);
    }
  }
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
  console.log('Open deze URL om de app te autoriseren (alleen nodig als token.json ontbreekt):\n', authUrl);
}

async function appendRows(values) {
  if (!sheets) throw new Error('Google Sheets niet geconfigureerd.');
  await ensureAuthenticated();
  return await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'A2:C',
    valueInputOption: 'RAW',
    requestBody: { values }
  });
}

// --- Discord bot setup ---
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.once('ready', async () => {
  console.log(`Bot online als ${client.user.tag}`);

  // Register slash commands (guild-scoped is fastest for dev)
  try {
    const commands = [
      new SlashCommandBuilder().setName('order').setDescription('Log een order').addStringOption(option =>
        option.setName('order_id').setDescription('Het order ID van de bestelling').setRequired(true)),
      new SlashCommandBuilder().setName('helpbot').setDescription('Toon hulp voor bot commando’s'),
      new SlashCommandBuilder().setName('register').setDescription('Registreer en krijg een agent-token (start agent lokaal met de token)'),
      new SlashCommandBuilder().setName('getproxy').setDescription('Vraag een nieuwe socks5 proxy aan (gebruik token)').addStringOption(opt => opt.setName('token').setDescription('Je agent token').setRequired(true))
    ];
    await client.application.commands.set(commands);
    console.log('Slash commands geregistreerd.');
  } catch (err) {
    console.warn('Kon slash commands niet registreren:', err.message || err);
  }
});

// --- Interaction handler (ROBUUST: deferReply + single-response safety) ---
client.on('interactionCreate', async (interaction) => {
  try {
    // Alleen slash chat-input commands
    if (!interaction.isChatInputCommand?.()) return;

    // Direct ACK sturen omdat sommige acties >3s kunnen duren
    await interaction.deferReply({ ephemeral: true });

    const name = interaction.commandName;

    // /order command (hield je al in de bot)
    if (name === 'order') {
      const orderId = interaction.options.getString('order_id');
      const worker = interaction.user.username;
      const date = new Date().toISOString();

      if (!orderId) {
        await interaction.editReply('Geef alstublieft een geldig order_id.');
        return;
      }

      const values = [[orderId, worker, date]];
      try {
        await appendRows(values);
        await interaction.editReply(`Order ID ${orderId} is geregistreerd door ${worker} op ${date}.`);
      } catch (err) {
        console.error('Fout bij toevoegen aan sheet:', err);
        await interaction.editReply('Kon order niet opslaan in sheet. Check logs.');
      }
      return;
    }

    // /helpbot
    if (name === 'helpbot') {
      await interaction.editReply('Gebruik: /order <order_id>, /helpbot, /register, /getproxy <token>');
      return;
    }

    // /register -> create token for this discord user via control-server
    if (name === 'register') {
      const res = await createTokenForDiscordUser(interaction.user.id);
      if (res && res.token) {
        await interaction.editReply({
          content:
            `Token aangemaakt. Start de agent op je machine met:\n\`\`\`\nAGENT_TOKEN=${res.token} node agent.js\n\`\`\`\nBewaar dit token veilig.`
        });
      } else {
        await interaction.editReply(`Kon token niet aanmaken: ${JSON.stringify(res)}`);
      }
      return;
    }

    // /getproxy <token>
    if (name === 'getproxy') {
      const token = interaction.options.getString('token', true);
      const r = await assignProxyByToken(token);
      if (r && r.ok) {
        await interaction.editReply('Proxy opdracht verstuurd. Als je agent online is wordt je poort ge-update.');
      } else {
        await interaction.editReply(`Fout: ${JSON.stringify(r)}`);
      }
      return;
    }

    // onbekend commando
    await interaction.editReply('Onbekend commando.');
  } catch (err) {
    console.error('Fout in interactionCreate handler:', err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('Er is een fout opgetreden. Check logs.');
      } else {
        await interaction.reply({ content: 'Er is een fout opgetreden. Check logs.', ephemeral: true });
      }
    } catch (e) {
      console.error('Kon gebruiker niet informeren:', e);
    }
  }
});

// login
(async () => {
  try {
    await client.login(TOKEN);
  } catch (err) {
    console.error('Discord login mislukt:', err.message || err);
    process.exit(1);
  }
})();

// health server (zodat Render / process managers weten dat de service up is)
http.createServer((req, res) => res.end('ok')).listen(DEFAULT_CALLBACK_PORT, () => {
  console.log('Health server listening on port', DEFAULT_CALLBACK_PORT);
});
