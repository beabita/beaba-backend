/**
 * beaba — api/sensors.js
 * CRUD capteurs temperature et CO2, scopes par campagne active.
 */

'use strict';
const { Router } = require('express');
const { getDb } = require('../db');
const weather = require('../lib/weather');
const { getDevices } = require('../mqtt/subscriber');

const router = Router();

// Au-dela de ce delai sans releve, un capteur est considere muet.
const SILENT_AFTER_MIN = 60;

/**
 * Etat des capteurs d'ambiance d'une campagne : liste les problemes qui
 * feraient sortir un rapport sans CO2 ou sans confort.
 * Chaque probleme : { level: 'error'|'warning', code, sensor?, message }.
 */
function sensorHealth(db, campaignId) {
  const issues = [];
  const devices = getDevices();
  const paired = new Set(devices.map((d) => d.friendly_name));

  const lastTs = (table) => db.prepare(`
    SELECT s.id, s.name, s.friendly_name, s.room_id,
           (SELECT MAX(r.ts) FROM ${table} r WHERE r.sensor_id = s.id) AS last_ts,
           (SELECT MAX(r.ts) FROM ${table} r WHERE r.sensor_id = s.id)
             >= datetime('now', '-${SILENT_AFTER_MIN} minutes') AS recent
    FROM ${table === 'readings_co2' ? 'co2_sensors' : 'temp_sensors'} s
    WHERE s.campaign_id = ?
  `).all(campaignId);

  const co2 = lastTs('readings_co2');
  const temp = lastTs('readings_temp');

  if (co2.length === 0) {
    issues.push({
      level: 'error', code: 'co2_missing',
      message: "Aucun capteur CO2 dans cette campagne. Verifiez qu'il est appaire dans zigbee2mqtt (bouton reset 5 s) puis declarez-le.",
    });
  }

  co2.forEach((s) => {
    if (devices.length > 0 && !paired.has(s.friendly_name)) {
      issues.push({ level: 'error', code: 'co2_unpaired', sensor: s.name,
        message: `Le capteur CO2 "${s.name}" n'est plus appaire au reseau Zigbee.` });
    } else if (!s.recent) {
      issues.push({ level: 'error', code: 'co2_silent', sensor: s.name,
        message: s.last_ts
          ? `Le capteur CO2 "${s.name}" n'envoie plus rien depuis ${s.last_ts} UTC.`
          : `Le capteur CO2 "${s.name}" n'a encore envoye aucune mesure.` });
    }
    if (!s.room_id) {
      issues.push({ level: 'warning', code: 'co2_no_room', sensor: s.name,
        message: `Le capteur CO2 "${s.name}" n'est affecte a aucune piece.` });
    }
  });

  temp.forEach((s) => {
    if (!s.recent) {
      issues.push({ level: 'warning', code: 'temp_silent', sensor: s.name,
        message: `La sonde "${s.name}" n'envoie plus rien depuis ${s.last_ts ? `${s.last_ts} UTC` : 'le debut'}.` });
    }
  });

  return { ok: !issues.some((i) => i.level === 'error'), issues };
}

// GET /health — problemes de capteurs de la campagne active
router.get('/health', (req, res) => {
  res.json(sensorHealth(getDb(), req.campaign.id));
});

// ── Capteurs temperature ─────────────────────────────────────────────

// GET /temp — lister les capteurs temp de la campagne active
router.get('/temp', (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT * FROM temp_sensors WHERE campaign_id = ?').all(req.campaign.id));
});

// POST /temp — creer un capteur temp
router.post('/temp', (req, res) => {
  const { id, friendly_name, name, room_id, comment } = req.body;
  if (!id || !friendly_name || !name) {
    return res.status(400).json({ error: 'id, friendly_name, name requis' });
  }
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO temp_sensors (id, campaign_id, room_id, name, friendly_name, comment)
    VALUES (?,?,?,?,?,?)
  `).run(id, req.campaign.id, room_id || null, name, friendly_name, comment || null);
  res.status(201).json({ ok: true });
});

// PUT /temp/:id — modifier un capteur temp
router.put('/temp/:id', (req, res) => {
  const { room_id, name, comment } = req.body;
  const db = getDb();
  const hasRoom = Object.prototype.hasOwnProperty.call(req.body, 'room_id');
  db.prepare(`
    UPDATE temp_sensors SET
      room_id = CASE WHEN ? = 1 THEN ? ELSE room_id END,
      name    = COALESCE(?, name),
      comment = COALESCE(?, comment)
    WHERE id = ? AND campaign_id = ?
  `).run(hasRoom ? 1 : 0, room_id || null, name, comment, req.params.id, req.campaign.id);
  res.json({ ok: true });
});

// DELETE /temp/:id — supprimer un capteur temp
router.delete('/temp/:id', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM temp_sensors WHERE id = ? AND campaign_id = ?').run(req.params.id, req.campaign.id);
  res.json({ ok: true });
});

// ── Capteurs CO2 ─────────────────────────────────────────────────────

// GET /co2 — lister les capteurs CO2 de la campagne active
router.get('/co2', (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT * FROM co2_sensors WHERE campaign_id = ?').all(req.campaign.id));
});

// POST /co2 — creer un capteur CO2
router.post('/co2', (req, res) => {
  const { id, friendly_name, name, room_id, comment } = req.body;
  if (!id || !friendly_name || !name) {
    return res.status(400).json({ error: 'id, friendly_name, name requis' });
  }
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO co2_sensors (id, campaign_id, room_id, name, friendly_name, comment)
    VALUES (?,?,?,?,?,?)
  `).run(id, req.campaign.id, room_id || null, name, friendly_name, comment || null);
  res.status(201).json({ ok: true });
});

// PUT /co2/:id — modifier un capteur CO2
router.put('/co2/:id', (req, res) => {
  const { room_id, name, comment } = req.body;
  const db = getDb();
  const hasRoom = Object.prototype.hasOwnProperty.call(req.body, 'room_id');
  db.prepare(`
    UPDATE co2_sensors SET
      room_id = CASE WHEN ? = 1 THEN ? ELSE room_id END,
      name    = COALESCE(?, name),
      comment = COALESCE(?, comment)
    WHERE id = ? AND campaign_id = ?
  `).run(hasRoom ? 1 : 0, room_id || null, name, comment, req.params.id, req.campaign.id);
  res.json({ ok: true });
});

// DELETE /co2/:id — supprimer un capteur CO2
router.delete('/co2/:id', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM co2_sensors WHERE id = ? AND campaign_id = ?').run(req.params.id, req.campaign.id);
  res.json({ ok: true });
});

// ── Calibration CO2 ───────────────────────────────────────────────────
// Le capteur est place a l'exterieur pendant quelques minutes, on compare
// la mediane des valeurs brutes a la concentration atmospherique mondiale
// (Mauna Loa via /api/weather/co2_atmospheric) et on stocke un offset
// applique a la lecture pour tous les endpoints CO2.

// GET /co2/:id/calibration — etat actuel
router.get('/co2/:id/calibration', (req, res) => {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, name, calibration_offset_ppm, calibration_at,
           calibration_raw_ppm, calibration_ref_ppm
    FROM co2_sensors WHERE id = ? AND campaign_id = ?
  `).get(req.params.id, req.campaign.id);
  if (!row) return res.status(404).json({ error: 'Capteur introuvable' });
  res.json(row);
});

// POST /co2/:id/calibrate?window_min=10
// 1. Median des releves bruts (sans offset) sur les window_min dernieres min
// 2. CO2 atmospherique reference (Mauna Loa)
// 3. offset = ref - median  -> stocke
router.post('/co2/:id/calibrate', async (req, res) => {
  const windowMin = Math.max(2, Math.min(60, parseInt(req.query.window_min, 10) || 10));
  const db = getDb();
  const sensor = db.prepare(
    'SELECT id, name FROM co2_sensors WHERE id = ? AND campaign_id = ?'
  ).get(req.params.id, req.campaign.id);
  if (!sensor) return res.status(404).json({ error: 'Capteur introuvable' });

  // Lectures brutes — pas d'offset applique en DB, on stocke toujours la valeur capteur.
  const since = new Date(Date.now() - windowMin * 60000).toISOString();
  const rows = db.prepare(`
    SELECT co2_ppm FROM readings_co2
    WHERE sensor_id = ? AND campaign_id = ? AND ts >= ? AND co2_ppm IS NOT NULL
    ORDER BY ts ASC
  `).all(req.params.id, req.campaign.id, since);

  if (rows.length < 5) {
    return res.status(400).json({
      error: 'Pas assez de releves dans la fenetre',
      detail: `${rows.length} releve(s) en ${windowMin} min — attendre que le capteur emette plus de donnees`,
    });
  }

  const values = rows.map((r) => r.co2_ppm).sort((a, b) => a - b);
  const median = values[Math.floor(values.length / 2)];

  let atm;
  try {
    atm = await weather.fetchAtmosphericCo2();
  } catch (err) {
    return res.status(502).json({ error: 'CO2 atmospherique indisponible', detail: String(err.message || err) });
  }
  if (!atm || atm.ppm == null) {
    return res.status(502).json({ error: 'CO2 atmospherique invalide' });
  }

  const offset = +(atm.ppm - median).toFixed(2);
  const at = new Date().toISOString();

  db.prepare(`
    UPDATE co2_sensors SET
      calibration_offset_ppm = ?,
      calibration_at         = ?,
      calibration_raw_ppm    = ?,
      calibration_ref_ppm    = ?
    WHERE id = ? AND campaign_id = ?
  `).run(offset, at, +median.toFixed(2), +atm.ppm.toFixed(2), req.params.id, req.campaign.id);

  res.json({
    ok: true,
    sample_count: rows.length,
    window_min: windowMin,
    raw_median_ppm: +median.toFixed(2),
    atmospheric_ppm: +atm.ppm.toFixed(2),
    atmospheric_source: atm.source,
    offset_ppm: offset,
    calibrated_at: at,
  });
});

// POST /co2/:id/calibration/reset — reinitialise l'offset
router.post('/co2/:id/calibration/reset', (req, res) => {
  const db = getDb();
  const r = db.prepare(`
    UPDATE co2_sensors SET
      calibration_offset_ppm = 0,
      calibration_at         = NULL,
      calibration_raw_ppm    = NULL,
      calibration_ref_ppm    = NULL
    WHERE id = ? AND campaign_id = ?
  `).run(req.params.id, req.campaign.id);
  res.json({ ok: true, changed: r.changes });
});

module.exports = router;
module.exports.sensorHealth = sensorHealth;
