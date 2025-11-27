// bot.js (vervang je huidige bestand door deze versie)
// Gebaseerd op je huidige bot (Sheets / health server etc.) maar uitgebreid met
// register + getproxy commands die met de control-server praten.
//
// Verwacht: NODE env vars:
//  - DISCORD_TOKEN (of BOT_TOKEN)  [reeds gebruikt door jouw oude bot]
//  - CONTROL_SERVER (bv http://localhost:3000)
//  - CONTROL_API_KEY (optioneel)

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, SlashCommandBuilder } = require('discord.js');
const { google } = require('googleapis');
const { createTokenForDiscordUser, assignProxyByToken, listAgents } = require('./pia_control_client');

// ---------- CONFIG (houd jouw bestaande Google/SHEET config) ----------
const CREDENTIALS_PATH = path.join(__dirname, 'google_oauth_credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');
const SPREADSHEET_ID = '1iFR1b3FQorkct4klp05DO7-R0XHRMLjmq1nvinoUU2k'; // behoud dit als je Sheets gebruikt
const LOCAL_CSV_PATH = '/mnt/data/November_2025-invoice.csv';
const DEFAULT_CALLBACK_PORT = 3000;
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
// ---------------------------------------------------------------------

const TOKEN = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN || null;
console.log('ENV DEBUG — hasDISCORD:', !!process.env.DISCORD_TOKEN, 'hasBOT:', !!process.env.BOT_TOKEN);

if (!TOKEN) {
  console.error('ERROR: Geen Discord token gevonden in environment. Zet DISCORD_TOKEN (of BOT_TOKEN) in Render/omgeving.');
  process.exit(1);
}

// Google auth (identiek aan jouw vorige file)
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
    console.warn('Fout bij inlezen credentials:', err.message || err);
  }
}

async function ensureAuthenticated() {
  if (!oauth2Client) {
    throw new Error('OAuth2 client niet geconfigureerd (google_oauth_credentials.json ontbreken).');
  }
  if (fs.existsSync(TOKEN_PATH)) {
    try {
      const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
      oauth2Client.setCredentials(token);
      return;
    } catch (e) {
      console.warn('Kon token.json niet lezen, opnieuw authenticeren...', e.message || e);
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

  // register slash commands (in jouw guilds / globally depending on setup)
  try {
    const commands = [
      new SlashCommandBuilder().setName('order').setDescription('Log een order').addStringOption(option =>
        option.setName('order_id').setDescription('Het order ID van de bestelling').setRequired(true)),
      new SlashCommandBuilder().setName('helpbot').setDescription('Toon hulp voor bot commando’s'),
      // PIA management commands
      new SlashCommandBuilder().setName('register').setDescription('Registreer en krijg een agent-token (start agent lokaal met de token)'),
      new SlashCommandBuilder().setName('getproxy').setDescription('Vraag een nieuwe socks5 proxy aan (gebruik token)').addStringOption(opt => opt.setName('token').setDescription('Je agent token').setRequired(true))
    ];
    await client.application.commands.set(commands);
    console.log('Slash commands geregistreerd.');
  } catch (err) {
    console.warn('Kon slash commands niet registreren:', err.message || err);
  }
});

// Handle commands (heet van jouw originele bot + nieuwe PIA commands)
client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isCommand()) return;

    const { commandName, options } = interaction;

    // bestaande order command
    if (commandName === 'order') {
      const orderId = options.getString('order_id');
      const worker = interaction.user.username;
      const date = new Date().toISOString();

      if (!orderId) {
        await interaction.reply('Geef alstublieft een geldig order_id.');
        return;
      }

      const values = [[orderId, worker, date]];
      try {
        await appendRows(values);
        await interaction.reply(`Order ID ${orderId} is geregistreerd door ${worker} op ${date}.`);
      } catch (err) {
        console.error('Fout bij toevoegen aan sheet:', err);
        await interaction.reply('Kon order niet opslaan in sheet. Check logs.');
      }
      return;
    }

    if (commandName === 'helpbot') {
      await interaction.reply('Gebruik: /order <order_id>, /helpbot, /register, /getproxy <token>');
      return;
    }

    // PIA: register -> create token for this discord user (returns token to start agent with)
    if (commandName === 'register') {
      await interaction.deferReply({ ephemeral: true });
      const res = await createTokenForDiscordUser(interaction.user.id);
      if (res.token) {
        await interaction.editReply({
          content:
            `Token aangemaakt. Start de agent op je machine met:\n\`\`\`\nAGENT_TOKEN=${res.token} node agent.js\n\`\`\`\nBewaar dit token veilig.`
        });
      } else {
        await interaction.editReply({ content: `Kon token niet aanmaken: ${JSON.stringify(res)}` });
      }
      return;
    }

    // PIA: getproxy (token)
    if (commandName === 'getproxy') {
      await interaction.deferReply({ ephemeral: true });
      const token = options.getString('token', true);

      // call control-server to assign proxy
      const r = await assignProxyByToken(token);
      if (r.ok) {
        await interaction.editReply({ content: 'Proxy opdracht verstuurd. Als je agent online is wordt je poort ge-update.' });
      } else {
        await interaction.editReply({ content: `Fout: ${JSON.stringify(r)}` });
      }
      return;
    }
  } catch (err) {
    console.error('Fout in interactionCreate:', err);
    if (!interaction.replied) {
      try { await interaction.reply('Er is iets fout gegaan. Check bot console.'); } catch (_) {}
    }
  }
});

// login safe (zoals in je oorspronkelijke bot)
(async () => {
  try {
    await client.login(TOKEN);
  } catch (err) {
    console.error('Discord login mislukt:', err.message || err);
    process.exit(1);
  }
})();

// health server (houdt je huidige behavior)
const http = require('http');
const port = process.env.PORT || DEFAULT_CALLBACK_PORT;
http.createServer((req, res) => res.end('ok')).listen(port, () => {
  console.log('Health server listening on port', port);
});
