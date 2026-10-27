/**
 * beaba — migrate.js
 * Cree le schema SQLite local sur le Raspberry Pi.
 * Sert de buffer offline et de source de verite pour la config du kit.
 * A lancer une fois au deploiement : node src/db/migrate.js
 */

'use strict';
require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Execution directe : node src/db/migrate.js
if (require.main === module) {
  const dbPath = process.env.SQLITE_PATH || './data/beaba.db';
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigration(db);

  db.close();
  console.log(`Migration OK — base : ${dbPath}`);
}

/**
 * Applique le schema complet. Exportee pour etre reutilisee par le wipe.
 */
function runMigration(database) {
  database.exec(`
    -- ── Utilisateurs ─────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      email      TEXT NOT NULL UNIQUE,
      name       TEXT NOT NULL,
      role       TEXT NOT NULL DEFAULT 'advisor' CHECK(role IN ('admin','advisor')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      active     INTEGER NOT NULL DEFAULT 1
    );

    -- ── Tokens d'authentification ────────────────────────────────────

    CREATE TABLE IF NOT EXISTS auth_tokens (
      token      TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL,
      used       INTEGER NOT NULL DEFAULT 0
    );

    -- ── Campagnes ──────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS campaigns (
      id            TEXT PRIMARY KEY,
      kit_id        TEXT NOT NULL,
      user_id       TEXT REFERENCES users(id),
      household     TEXT NOT NULL,
      address       TEXT,
      start_date    TEXT NOT NULL,
      expected_days INTEGER NOT NULL DEFAULT 30,
      status        TEXT NOT NULL DEFAULT 'setup' CHECK(status IN ('setup','active','completed')),
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at  TEXT,
      notes         TEXT
    );

    -- ── Pieces ────────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS rooms (
      id          TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      name        TEXT NOT NULL,
      color       TEXT NOT NULL DEFAULT '#888780',
      sort_order  INTEGER NOT NULL DEFAULT 0
    );

    -- ── Capteurs temperature / humidite (Sonoff SNZB-02P) ─────────────

    CREATE TABLE IF NOT EXISTS temp_sensors (
      id            TEXT PRIMARY KEY,
      campaign_id   TEXT NOT NULL REFERENCES campaigns(id),
      room_id       TEXT REFERENCES rooms(id),
      name          TEXT NOT NULL,
      friendly_name TEXT NOT NULL,
      comment       TEXT
    );

    -- ── Capteur CO2 (Heiman HS3AQ) ────────────────────────────────────

    CREATE TABLE IF NOT EXISTS co2_sensors (
      id                      TEXT PRIMARY KEY,
      campaign_id             TEXT NOT NULL REFERENCES campaigns(id),
      room_id                 TEXT REFERENCES rooms(id),
      name                    TEXT NOT NULL,
      friendly_name           TEXT NOT NULL,
      comment                 TEXT,
      calibration_offset_ppm  REAL NOT NULL DEFAULT 0,
      calibration_at          TEXT,
      calibration_raw_ppm     REAL,
      calibration_ref_ppm     REAL
    );

    -- ── Prises de mesure ──────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS plugs (
      id              TEXT PRIMARY KEY,
      campaign_id     TEXT NOT NULL REFERENCES campaigns(id),
      room_id         TEXT REFERENCES rooms(id),
      source          TEXT NOT NULL CHECK(source IN ('innr','shelly_em')),
      zigbee_id       TEXT,
      shelly_channel  INTEGER,
      appliance_name  TEXT NOT NULL,
      rated_power_w   INTEGER,
      sort_order      INTEGER NOT NULL DEFAULT 0,
      energy_offset_kwh REAL DEFAULT 0,
      is_multiprise   INTEGER NOT NULL DEFAULT 0
    );

    -- ── Appareils branches sur une prise (1..N par prise) ──────────────

    CREATE TABLE IF NOT EXISTS plug_appliances (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      plug_id       TEXT NOT NULL REFERENCES plugs(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      category      TEXT,
      rated_power_w INTEGER,
      always_on     INTEGER NOT NULL DEFAULT 0,
      control_type  TEXT,
      sort_order    INTEGER NOT NULL DEFAULT 0
    );

    -- ── Releves temperature / humidite ────────────────────────────────

    CREATE TABLE IF NOT EXISTS readings_temp (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      sensor_id     TEXT NOT NULL REFERENCES temp_sensors(id),
      campaign_id   TEXT NOT NULL,
      ts            TEXT NOT NULL DEFAULT (datetime('now')),
      temperature_c REAL NOT NULL,
      humidity_pct  REAL NOT NULL,
      battery_pct   INTEGER,
      synced        INTEGER NOT NULL DEFAULT 0
    );

    -- ── Releves CO2 ───────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS readings_co2 (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      sensor_id     TEXT NOT NULL REFERENCES co2_sensors(id),
      campaign_id   TEXT NOT NULL,
      ts            TEXT NOT NULL DEFAULT (datetime('now')),
      co2_ppm       INTEGER NOT NULL,
      temperature_c REAL,
      humidity_pct  REAL,
      synced        INTEGER NOT NULL DEFAULT 0
    );

    -- ── Releves puissance (Innr + Shelly EM) ─────────────────────────

    CREATE TABLE IF NOT EXISTS readings_power (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      plug_id       TEXT NOT NULL REFERENCES plugs(id),
      campaign_id   TEXT NOT NULL,
      ts            TEXT NOT NULL DEFAULT (datetime('now')),
      power_w       REAL NOT NULL,
      energy_kwh    REAL,
      synced        INTEGER NOT NULL DEFAULT 0
    );

    -- ── Releves compteurs (electricite, gaz, eau) ─────────────────────

    CREATE TABLE IF NOT EXISTS meter_readings (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id   TEXT NOT NULL REFERENCES campaigns(id),
      meter_type    TEXT NOT NULL CHECK(meter_type IN ('electricity','gas','water')),
      phase         TEXT NOT NULL CHECK(phase IN ('start','end')),
      value         REAL NOT NULL,
      unit          TEXT NOT NULL,
      photo_path    TEXT,
      recorded_at   TEXT NOT NULL DEFAULT (datetime('now')),
      notes         TEXT,
      UNIQUE(campaign_id, meter_type, phase)
    );

    -- ── Index pour les requetes frequentes ───────────────────────────

    CREATE INDEX IF NOT EXISTS idx_rtemp_sensor   ON readings_temp(sensor_id, ts);
    CREATE INDEX IF NOT EXISTS idx_rtemp_synced   ON readings_temp(synced, ts);
    CREATE INDEX IF NOT EXISTS idx_rco2_sensor    ON readings_co2(sensor_id, ts);
    CREATE INDEX IF NOT EXISTS idx_rco2_synced    ON readings_co2(synced, ts);
    CREATE INDEX IF NOT EXISTS idx_rpow_plug      ON readings_power(plug_id, ts);
    CREATE INDEX IF NOT EXISTS idx_rpow_synced    ON readings_power(synced, ts);
    CREATE INDEX IF NOT EXISTS idx_campaign_status ON campaigns(status);
    CREATE INDEX IF NOT EXISTS idx_plug_appliances_plug ON plug_appliances(plug_id);
  `);

  // ── Capteurs sur tuyaux / cuves (analyse chaudiere, ECS) ───────────
  database.exec(`
    CREATE TABLE IF NOT EXISTS pipe_sensors (
      id              TEXT PRIMARY KEY,
      campaign_id     TEXT NOT NULL REFERENCES campaigns(id),
      name            TEXT NOT NULL,
      kind            TEXT NOT NULL CHECK(kind IN ('boiler_out','boiler_return','dhw_tank','radiator')) DEFAULT 'boiler_out',
      shelly_ip       TEXT,
      shelly_channel  INTEGER NOT NULL DEFAULT 100,
      color           TEXT NOT NULL DEFAULT '#f59e0b',
      sort_order      INTEGER NOT NULL DEFAULT 0,
      baseline_c      REAL DEFAULT 30,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS readings_pipe_temp (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      sensor_id     TEXT NOT NULL REFERENCES pipe_sensors(id),
      campaign_id   TEXT NOT NULL,
      ts            TEXT NOT NULL DEFAULT (datetime('now')),
      temperature_c REAL,
      synced        INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_rpipe_sensor ON readings_pipe_temp(sensor_id, ts);
    CREATE INDEX IF NOT EXISTS idx_rpipe_synced ON readings_pipe_temp(synced, ts);
  `);

  // ── Migrations idempotentes pour bases existantes ──────────────────
  // Ajoute is_multiprise si la colonne n'existe pas encore.
  const plugCols = database.prepare("PRAGMA table_info(plugs)").all();
  if (!plugCols.some((c) => c.name === 'is_multiprise')) {
    database.exec("ALTER TABLE plugs ADD COLUMN is_multiprise INTEGER NOT NULL DEFAULT 0");
  }

  // Colonnes de calibration CO2 (ajout en cours de vie du projet).
  const co2Cols = database.prepare("PRAGMA table_info(co2_sensors)").all();
  const hasCol = (n) => co2Cols.some((c) => c.name === n);
  if (!hasCol('calibration_offset_ppm')) {
    database.exec("ALTER TABLE co2_sensors ADD COLUMN calibration_offset_ppm REAL NOT NULL DEFAULT 0");
  }
  if (!hasCol('calibration_at')) {
    database.exec("ALTER TABLE co2_sensors ADD COLUMN calibration_at TEXT");
  }
  if (!hasCol('calibration_raw_ppm')) {
    database.exec("ALTER TABLE co2_sensors ADD COLUMN calibration_raw_ppm REAL");
  }
  if (!hasCol('calibration_ref_ppm')) {
    database.exec("ALTER TABLE co2_sensors ADD COLUMN calibration_ref_ppm REAL");
  }

  // Droit d'appairage Zigbee pour les conseillers (les admins l'ont d'office).
  const userCols = database.prepare("PRAGMA table_info(users)").all();
  if (!userCols.some((c) => c.name === 'can_pair')) {
    database.exec("ALTER TABLE users ADD COLUMN can_pair INTEGER NOT NULL DEFAULT 0");
  }

  // Date du dernier telechargement complet de l'archive : condition pour
  // effacer la campagne et en demarrer une nouvelle.
  const campaignCols = database.prepare("PRAGMA table_info(campaigns)").all();
  if (!campaignCols.some((c) => c.name === 'archived_at')) {
    database.exec("ALTER TABLE campaigns ADD COLUMN archived_at TEXT");
  }

  // Seed admin user
  database.prepare(`
    INSERT OR IGNORE INTO users (id, email, name, role) VALUES ('admin-001', 'benoit@450ppm.be', 'Benoit', 'admin')
  `).run();
}

module.exports = { runMigration };
