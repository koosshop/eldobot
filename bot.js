// bot.js (veilige versie voor Render / lokaal gebruik)
// - leest token uit process.env.DISCORD_TOKEN (fallback BOT_TOKEN)
// - health endpoint zodat Render tevreden is
// - korte ENV debug zonder token te loggen

require('dotenv').config(); // blijft werken voor lokaal testen (maar zet nooit .env in git)
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, SlashCommandBuilder } = require('discord.js');
const { google } = require('googleapis');

// ---------- CONFIG ----------
const CREDENTIALS_PATH = path.join(__dirname, 'google_oauth_credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');
const SPREADSHEET_ID = '1iFR1b3FQorkct4klp05DO7-R0XHRMLjmq1nvinoUU2k'; // je Google Sheet ID
const LOCAL_CSV_PATH = '/mnt/data/November_2025-invoice.csv';
const DEFAULT_CALLBACK_PORT = 3000;
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
// ----------------------------

// Environment token handling (veilige voorkeur voor DISCORD_TOKEN)
const TOKEN = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN || null;
console.log('ENV DEBUG — hasDISCORD:', !!process.env.DISCORD_TOKEN, 'hasBOT:', !!process.env.BOT_TOKEN);

if (!TOKEN) {
  console.error('ERROR: Geen Discord token gevonden in environment. Zet DISCORD_TOKEN (of BOT_TOKEN) in Render/omgeving.');
  process.exit(1);
}

// Validate Google credentials file exists (if your bot needs Google Sheets)
if (!fs.existsSync(CREDENTIALS_PATH)) {
  console.error('ERROR: credentials bestand niet gevonden:', CREDENTIALS_PATH);
  // We do NOT exit here forcibly because you may want the bot to run without Sheets in test env.
  // If Sheets are required for your use-case, uncomment the next line:
  // process.exit(1);
}

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

// --- Google Sheets helpers ---
async function getExistingOrderIdsFromSheet() {
  if (!sheets) return [];
  await ensureAuthenticated();
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'A2:A' });
    const values = res.data.values || [];
    return values.map(v => (v[0] || '').toString());
  } catch (err) {
    console.warn('Kon bestaande Order IDs niet ophalen:', err.message || err);
    return [];
  }
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

// --- Discord bot ---
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.once('ready', () => {
  console.log(`Bot online als ${client.user.tag}`);
});

// Register slash commands (run on ready)
client.on('ready', async () => {
  try {
    const commands = [
      new SlashCommandBuilder().setName('order').setDescription('Log een order').addStringOption(option =>
        option.setName('order_id').setDescription('Het order ID van de bestelling').setRequired(true)),
      new SlashCommandBuilder().setName('helpbot').setDescription('Toon hulp voor bot commando’s')
    ];
    await client.application.commands.set(commands);
    console.log('Slash commands geregistreerd.');
  } catch (err) {
    console.warn('Kon slash commands niet registreren:', err.message || err);
  }
});

// Handle command
client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isCommand()) return;

    const { commandName, options } = interaction;

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
    }

    if (commandName === 'helpbot') {
      await interaction.reply('Gebruik: /order <order_id>, /helpbot');
    }
  } catch (err) {
    console.error('Fout in interactionCreate:', err);
    if (!interaction.replied) {
      try { await interaction.reply('Er is iets fout gegaan. Check bot console.'); } catch (_) {}
    }
  }
});

// Safe login
(async () => {
  try {
    await client.login(TOKEN);
    // client.login resolves when logged in, so no need to exit here.
  } catch (err) {
    console.error('Discord login mislukt:', err.message || err);
    // if token invalid, exit with non-zero status so platform shows it failed
    process.exit(1);
  }
})();

// Health server so Render / platforms that expect a port are happy
const http = require('http');
const port = process.env.PORT || DEFAULT_CALLBACK_PORT;
http.createServer((req, res) => res.end('ok')).listen(port, () => {
  console.log('Health server listening on port', port);
});
