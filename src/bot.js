require('dotenv').config();
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

if (!process.env.BOT_TOKEN) {
  console.error('ERROR: maak een .env bestand met BOT_TOKEN=je_discord_token');
  process.exit(1);
}
if (!fs.existsSync(CREDENTIALS_PATH)) {
  console.error('ERROR: credentials bestand niet gevonden:', CREDENTIALS_PATH);
  process.exit(1);
}

const rawCreds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
const webCreds = rawCreds.web || rawCreds.installed || rawCreds;
const { client_id, client_secret, redirect_uris } = webCreds;

const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

async function ensureAuthenticated() {
  if (fs.existsSync(TOKEN_PATH)) {
    try {
      const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
      oauth2Client.setCredentials(token);
      return;
    } catch (e) {
      console.warn('Kon token.json niet lezen, opnieuw authenticeren...');
    }
  }
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
  console.log('Open deze URL om de app te autoriseren:\n', authUrl);
}

// --- Google Sheets helpers ---
// Get existing Order IDs from the Google Sheet
async function getExistingOrderIdsFromSheet() {
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

// Append new rows to the Google Sheet
async function appendRows(values) {
  await ensureAuthenticated();
  return await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'A2:C', // Alleen kolommen A (Order ID), B (Werknemer), C (Datum)
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

// Register slash commands
client.on('ready', async () => {
  const commands = [
    new SlashCommandBuilder().setName('order').setDescription('Log een order').addStringOption(option =>
      option.setName('order_id').setDescription('Het order ID van de bestelling').setRequired(true)),
    new SlashCommandBuilder().setName('helpbot').setDescription('Toon hulp voor bot commando’s')
  ];

  await client.application.commands.set(commands);
});

// Handle command
client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isCommand()) return;

    const { commandName, options } = interaction;

    if (commandName === 'order') {
      const orderId = options.getString('order_id');
      const worker = interaction.user.username;  // Het Discord naam van de werker
      const date = new Date().toISOString();  // De huidige datum en tijd

      if (!orderId) {
        await interaction.reply('Geef alstublieft een geldig order_id.');
        return;
      }

      // Voeg deze order toe aan de sheet met alleen Order ID, Werknemer, en Datum
      const values = [
        [orderId, worker, date]
      ];
      await appendRows(values);
      await interaction.reply(`Order ID ${orderId} is geregistreerd door ${worker} op ${date}.`);
    }

    if (commandName === 'helpbot') {
      await interaction.reply('Gebruik: /order <order_id>, /upload, /payout_report, /helpbot');
    }
  } catch (err) {
    console.error('Fout in interactionCreate:', err);
    await interaction.reply('Er is iets fout gegaan. Check bot console.');
  }
});
// debug (verwijder later) — toont alleen true/false, geen token
console.log('ENV DEBUG — hasDISCORD:', !!process.env.DISCORD_TOKEN, 'hasBOT:', !!process.env.BOT_TOKEN);

// prefer DISCORD_TOKEN, fallback op BOT_TOKEN (veilig)
const TOKEN = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN;
client.login(TOKEN);

client.login(process.env.BOT_TOKEN).catch(err => { console.error('Discord login mislukt:', err); process.exit(1); });
