/**
 * beaba — api/campaign.js
 * CRUD campagnes + wipe complet.
 */

'use strict';
const { Router } = require('express');
const crypto = require('crypto');
const { getDb, getActiveCampaign } = require('../db');
const { runMigration } = require('../db/migrate');
const { sensorHealth } = require('./sensors');

const router = Router();

// GET / — campagne la plus recente (active, setup ou completed)
router.get('/', (req, res) => {
  const db = getDb();
  let campaign;
  if (req.user.role === 'admin') {
    campaign = db.prepare("SELECT * FROM campaigns ORDER BY created_at DESC LIMIT 1").get();
  } else {
    campaign = db.prepare("SELECT * FROM campaigns WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").get(req.user.id);
  }
  if (!campaign) return res.status(404).json({ error: 'Aucune campagne' });
  res.json(campaign);
});

// POST / — creer une campagne
router.post('/', (req, res) => {
  const { household, address, start_date, expected_days, notes, kit_id } = req.body;
  if (!household || !start_date) {
    return res.status(400).json({ error: 'household et start_date requis' });
  }

  const db = getDb();

  // Verifier qu'aucune campagne non-completed n'existe pour cet utilisateur
  const existingQuery = req.user.role === 'admin'
    ? "SELECT id FROM campaigns WHERE status IN ('setup','active')"
    : "SELECT id FROM campaigns WHERE status IN ('setup','active') AND user_id = ?";
  const existing = req.user.role === 'admin'
    ? db.prepare(existingQuery).get()
    : db.prepare(existingQuery).get(req.user.id);
  if (existing) {
    return res.status(409).json({ error: 'Une campagne non terminee existe deja', campaign_id: existing.id });
  }

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO campaigns (id, kit_id, user_id, household, address, start_date, expected_days, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, kit_id || 'beaba_001', req.user.id, household, address || null, start_date, expected_days || 30, notes || null);

  res.status(201).json({ id });
});

// PUT /:id — modifier les champs d'une campagne
router.put('/:id', (req, res) => {
  const { household, address, notes, expected_days } = req.body;
  const db = getDb();
  db.prepare(`
    UPDATE campaigns SET
      household     = COALESCE(?, household),
      address       = COALESCE(?, address),
      notes         = COALESCE(?, notes),
      expected_days = COALESCE(?, expected_days)
    WHERE id = ?
  `).run(household, address, notes, expected_days, req.params.id);
  res.json({ ok: true });
});

// POST /:id/activate — passer en status='active'
router.post('/:id/activate', (req, res) => {
  const db = getDb();
  const campaignId = req.params.id;

  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  if (!campaign) return res.status(404).json({ error: 'Campagne introuvable' });
  if (req.user.role !== 'admin' && campaign.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Acces interdit' });
  }
  if (campaign.status === 'completed') return res.status(400).json({ error: 'Campagne deja terminee' });

  // Verifier qu'au moins 1 room existe
  const roomCount = db.prepare('SELECT COUNT(*) AS cnt FROM rooms WHERE campaign_id = ?').get(campaignId);
  if (roomCount.cnt === 0) {
    return res.status(400).json({ error: 'Au moins une piece est requise avant activation' });
  }

  // Capturer l'offset energy de chaque prise (valeur cumulee actuelle)
  // Pour calculer la conso de la campagne = energy_actuel - energy_offset
  const plugs = db.prepare("SELECT id, zigbee_id FROM plugs WHERE campaign_id = ?").all(campaignId);
  const lastReadings = db.prepare(`
    SELECT plug_id, energy_kwh FROM readings_power
    WHERE plug_id = ? ORDER BY ts DESC LIMIT 1
  `);
  plugs.forEach((plug) => {
    const last = lastReadings.get(plug.id);
    if (last && last.energy_kwh != null) {
      db.prepare('UPDATE plugs SET energy_offset_kwh = ? WHERE id = ?').run(last.energy_kwh, plug.id);
    }
  });

  db.prepare("UPDATE campaigns SET status = 'active' WHERE id = ?").run(campaignId);

  // Avant activation aucun releve n'est stocke : on ne remonte que les
  // problemes de declaration/appairage, pas les capteurs « muets ».
  const warnings = sensorHealth(db, campaignId).issues
    .filter((i) => !i.code.endsWith('_silent'));
  res.json({ ok: true, warnings });
});

// POST /:id/complete — terminer une campagne
router.post('/:id/complete', (req, res) => {
  const db = getDb();
  const campaignId = req.params.id;

  const campaignCheck = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  if (!campaignCheck) return res.status(404).json({ error: 'Campagne introuvable' });
  if (req.user.role !== 'admin' && campaignCheck.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Acces interdit' });
  }

  // Verifier que tous les releves compteurs existent (3 types x 2 phases)
  const readings = db.prepare(
    'SELECT meter_type, phase FROM meter_readings WHERE campaign_id = ?'
  ).all(campaignId);

  const required = [
    { meter_type: 'electricity', phase: 'start' },
    { meter_type: 'electricity', phase: 'end' },
    { meter_type: 'gas', phase: 'start' },
    { meter_type: 'gas', phase: 'end' },
    { meter_type: 'water', phase: 'start' },
    { meter_type: 'water', phase: 'end' },
  ];

  const missing = required.filter(
    r => !readings.some(rd => rd.meter_type === r.meter_type && rd.phase === r.phase)
  );

  if (missing.length > 0) {
    return res.status(400).json({
      error: 'Releves compteurs manquants',
      missing: missing.map(m => `${m.meter_type}_${m.phase}`),
    });
  }

  db.prepare("UPDATE campaigns SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(campaignId);
  res.json({ ok: true });
});

// DELETE /:id — effacer une campagne terminee pour en demarrer une nouvelle.
// Ouvert au proprietaire (conseiller) ; exige que l'archive ait ete
// telechargee entierement apres la cloture.
router.delete('/:id', (req, res) => {
  const db = getDb();
  const campaignId = req.params.id;

  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  if (!campaign) return res.status(404).json({ error: 'Campagne introuvable' });
  if (req.user.role !== 'admin' && campaign.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Acces interdit' });
  }
  if (campaign.status !== 'completed') {
    return res.status(400).json({ error: 'Seule une campagne terminee peut etre effacee' });
  }
  if (!campaign.archived_at || campaign.archived_at < campaign.completed_at) {
    return res.status(409).json({ error: "Telechargez l'archive complete avant d'effacer la campagne" });
  }

  db.transaction(() => {
    db.prepare('DELETE FROM plug_appliances WHERE plug_id IN (SELECT id FROM plugs WHERE campaign_id = ?)').run(campaignId);
    for (const t of [
      'readings_temp', 'readings_co2', 'readings_power', 'readings_pipe_temp', 'meter_readings',
      'plugs', 'temp_sensors', 'co2_sensors', 'pipe_sensors', 'rooms',
    ]) {
      db.prepare(`DELETE FROM ${t} WHERE campaign_id = ?`).run(campaignId);
    }
    db.prepare('DELETE FROM campaigns WHERE id = ?').run(campaignId);
  })();

  res.json({ ok: true });
});

// POST /wipe — tout supprimer et recreer le schema (admin seulement)
router.post('/wipe', (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acces reserve aux administrateurs' });
  }

  const db = getDb();
  const tables = [
    'auth_tokens',
    'readings_temp', 'readings_co2', 'readings_power', 'meter_readings',
    'plug_appliances',
    'plugs', 'temp_sensors', 'co2_sensors', 'rooms', 'campaigns', 'users'
  ];
  db.exec('PRAGMA foreign_keys = OFF');
  for (const t of tables) {
    db.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  db.exec('PRAGMA foreign_keys = ON');

  runMigration(db);
  res.json({ ok: true, message: 'Base videe et schema recree' });
});

module.exports = router;
