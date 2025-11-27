// bot.js — complete ready-to-run vervanging
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Client, GatewayIntentBits, SlashCommandBuilder } = require('discord.js');
const { google } = require('googleapis');

// PIA control client (zorg dat pia_control_client.js in dezelfde map staat)
let piaClient;
try {
  piaClient = require('./pia_control_client');
} catch (e) {
  console.warn('pia_control_client.js niet gevonden. PIA-commands zullen niet werken totdat dat bestand aanwezig is.');
  piaClient = {
    createTokenForDiscordUser: async () => ({ error: 'pia_control_client missing' }),
    assignProxyByToken: async () => ({ error: 'pia_control_client missing' })
  };
}
const { createTokenForDiscordUser, assignProxyByToken } = piaClient;

// ---------- CONFIG (opties) ----------
const CREDENTIALS_PATH = path.join(__dirname, 'google_oauth_credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1iFR1b3FQorkct4klp05DO7-R0XHRMLjmq1nvinoUU2k';
const DEFAULT_CALLBACK_PORT = process.env.PORT || 3000;
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
// ---------------------------------------------------------------------

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN;
if (!DISCORD_TOKEN) {
  console.error('ERROR: Geen Discord token gevonden in environment. Zet DISCORD_TOKEN of BOT_TOKEN.');
  process.exit(1);
}

// Google Sheets (optioneel)
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
    console.warn('Kan google_oauth_credentials.json niet inlezen:', err.message || err);
  }
}

async function ensureAuthenticated() {
  if (!oauth2Client) throw new Error('OAuth2 client niet geconfigureerd.');
  if (fs.existsSync(TOKEN_PATH)) {
    try {
      const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
      oauth2Client.setCredentials(token);
      return;
    } catch (e) {
      console.warn('Kon token.json niet lezen, je moet opnieuw autoriseren:', e.message || e);
    }
  }
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
  console.log('Autorisatie URL (bezoek om token te genereren):', authUrl);
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

  // Register slash commands (guild/global depending on your setup)
  try {
    const commands = [
      new SlashCommandBuilder().setName('order').setDescription('Log een order')
        .addStringOption(option => option.setName('order_id').setDescription('Het order ID').setRequired(true)),
      new SlashCommandBuilder().setName('helpbot').setDescription('Toon hulp voor bot commando’s'),
      new SlashCommandBuilder().setName('register').setDescription('Registreer en krijg een agent-token'),
      new SlashCommandBuilder().setName('getproxy').setDescription('Vraag een nieuwe socks5 proxy aan (gebruik token)')
        .addStringOption(opt => opt.setName('token').setDescription('Agent token').setRequired(true))
    ];
    await client.application.commands.set(commands);
    console.log('Slash commands geregistreerd.');
  } catch (err) {
    console.warn('Kon slash commands niet registreren:', err.message || err);
  }
});

// -------- Veilige interactionCreate handler (copy-paste ready) ----------
client.on('interactionCreate', async (interaction) => {
  // Helper: veilige reply/edit met foutafhandeling
  async function safeRespond(inter, content, opts = {}) {
    // opts { ephemeral: boolean, editInsteadOfReply: boolean }
    try {
      if (inter.replied || inter.deferred || opts.editInsteadOfReply) {
        try {
          await inter.editReply(typeof content === 'string' ? { content } : content);
          return { ok: true };
        } catch (err) {
          console.warn('safeRespond.editReply error:', err?.code || err?.message || err);
          try {
            await inter.followUp({ content: typeof content === 'string' ? content : content, ephemeral: opts.ephemeral ?? true });
            return { ok: true };
          } catch (err2) {
            console.warn('safeRespond.followUp error (fallback):', err2?.code || err2?.message || err2);
            return { ok: false, error: err2 };
          }
        }
      } else {
        await inter.reply(typeof content === 'string' ? { content, ephemeral: opts.ephemeral ?? true } : content);
        return { ok: true };
      }
    } catch (err) {
      console.warn('safeRespond.general error:', err?.code || err?.message || err);
      return { ok: false, error: err };
    }
  }

  try {
    if (!interaction.isChatInputCommand?.()) return;
    const name = interaction.commandName;

    // probeer direct te deferen (voorkomt 3s timeout). Fout negeren als het al gebeurd is.
    try {
      if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
    } catch (e) {
      console.warn('deferReply faalde (ignored):', e?.code || e?.message || e);
    }

    // /order
    if (name === 'order') {
      const orderId = interaction.options.getString('order_id');
      const worker = interaction.user.username;
      const date = new Date().toISOString();
      if (!orderId) {
        await safeRespond(interaction, 'Geef alstublieft een geldig order_id.', { editInsteadOfReply: true });
        return;
      }
      const values = [[orderId, worker, date]];
      try {
        await appendRows(values);
        await safeRespond(interaction, `Order ID ${orderId} is geregistreerd door ${worker} op ${date}.`, { editInsteadOfReply: true });
      } catch (err) {
        console.error('Fout bij Sheets append:', err);
        await safeRespond(interaction, 'Kon order niet opslaan in sheet. Check logs.', { editInsteadOfReply: true });
      }
      return;
    }

    // /helpbot
    if (name === 'helpbot') {
      await safeRespond(interaction, 'Gebruik: /order <order_id>, /helpbot, /register, /getproxy <token>', { editInsteadOfReply: true });
      return;
    }

    // /register -> maak token via control-server
    if (name === 'register') {
      const res = await createTokenForDiscordUser(interaction.user.id);
      if (res && res.token) {
        await safeRespond(interaction, {
          content:
            `Token aangemaakt. Start de agent op je machine met:\n\`\`\`\nAGENT_TOKEN=${res.token} node agent.js\n\`\`\`\nBewaar dit token veilig.`
        }, { editInsteadOfReply: true });
      } else {
        await safeRespond(interaction, `Kon token niet aanmaken: ${JSON.stringify(res)}`, { editInsteadOfReply: true });
      }
      return;
    }

    // /getproxy token
    if (name === 'getproxy') {
      const token = interaction.options.getString('token', true);
      const r = await assignProxyByToken(token);
      if (r && r.ok) {
        await safeRespond(interaction, 'Proxy opdracht verstuurd. Als je agent online is wordt je poort ge-update.', { editInsteadOfReply: true });
      } else {
        await safeRespond(interaction, `Fout: ${JSON.stringify(r)}`, { editInsteadOfReply: true });
      }
      return;
    }

    // onbekend commando
    await safeRespond(interaction, 'Onbekend commando.', { editInsteadOfReply: true });
  } catch (err) {
    console.error('Unexpected error in interactionCreate:', err);
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply('Er is een fout opgetreden. Check logs.');
      } else {
        await interaction.reply({ content: 'Er is een fout opgetreden. Check logs.', ephemeral: true });
      }
    } catch (finalErr) {
      console.warn('Kon gebruiker niet informeren (final fallback):', finalErr?.code || finalErr?.message || finalErr);
    }
  }
});

// login
(async () => {
  try {
    await client.login(DISCORD_TOKEN);
  } catch (err) {
    console.error('Discord login mislukt:', err.message || err);
    process.exit(1);
  }
})();

// eenvoudige health endpoint
http.createServer((req, res) => res.end('ok')).listen(DEFAULT_CALLBACK_PORT, () => {
  console.log('Health server listening on port', DEFAULT_CALLBACK_PORT);
});
