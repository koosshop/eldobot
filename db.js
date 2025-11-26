const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(process.env.DB_PATH || './data/eldobot.db');

function init(){
  db.exec(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT,
    submitted_by TEXT,
    discord_id TEXT,
    submitted_at TEXT,
    status TEXT,
    txn_id TEXT,
    proof_url TEXT,
    eld_amount_usd REAL,
    eld_net_income_usd REAL,
    worker_pay_eur REAL,
    platform_net_eur REAL,
    verified_by TEXT,
    verified_at TEXT
  );`);
}

module.exports = { db, init };
