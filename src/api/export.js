/**
 * beaba -- api/export.js
 * Export des donnees brutes d'une campagne (CSV ZIP ou JSON).
 */

'use strict';
const { Router } = require('express');
const { Readable } = require('stream');
const archiver = require('archiver');
const { getDb } = require('../db');
const { generateReport } = require('../report/generator');

const router = Router();

const BOM = '﻿';

function csvCell(val) {
  if (val == null) return '';
  const str = String(val);
  if (str.includes(';') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function toCsv(rows) {
  if (!rows || rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(';')];
  for (const row of rows) {
    lines.push(headers.map(h => csvCell(row[h])).join(';'));
  }
  return lines.join('\n');
}

/**
 * Cree un Readable stream CSV (avec BOM) a partir d'un iterateur SQLite.
 * Streame ligne par ligne — pas de chargement en RAM.
 */
function csvStreamFromIterator(iter) {
  let headers = null;
  return Readable.from((function* () {
    yield BOM;
    for (const row of iter) {
      if (!headers) {
        headers = Object.keys(row);
        yield headers.join(';') + '\n';
      }
      yield headers.map(h => csvCell(row[h])).join(';') + '\n';
    }
  })());
}

function loadExportData(db, campaignId) {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  if (!campaign) return null;

  const rooms = db.prepare(
    'SELECT id, name, color, sort_order FROM rooms WHERE campaign_id = ? ORDER BY sort_order, name'
  ).all(campaignId);

  const tempSensors = db.prepare(`
    SELECT ts.id, ts.name, ts.friendly_name, ts.comment,
      COALESCE(r.name, '') AS room_name
    FROM temp_sensors ts
    LEFT JOIN rooms r ON r.id = ts.room_id
    WHERE ts.campaign_id = ?
    ORDER BY ts.name
  `).all(campaignId);

  const plugs = db.prepare(`
    SELECT p.id, p.source, p.appliance_name, p.rated_power_w, p.sort_order,
      COALESCE(r.name, '') AS room_name
    FROM plugs p
    LEFT JOIN rooms r ON r.id = p.room_id
    WHERE p.campaign_id = ?
    ORDER BY p.sort_order
  `).all(campaignId);

  const readingsTemp = db.prepare(`
    SELECT rt.ts, rt.temperature_c, rt.humidity_pct, rt.battery_pct,
      ts.name AS sensor_name, ts.friendly_name AS sensor_friendly_name
    FROM readings_temp rt
    JOIN temp_sensors ts ON ts.id = rt.sensor_id
    WHERE rt.campaign_id = ?
    ORDER BY rt.ts
  `).all(campaignId);

  const readingsPower = db.prepare(`
    SELECT rp.ts, rp.power_w, rp.energy_kwh,
      p.appliance_name, COALESCE(r.name, '') AS room_name
    FROM readings_power rp
    JOIN plugs p ON p.id = rp.plug_id
    LEFT JOIN rooms r ON r.id = p.room_id
    WHERE rp.campaign_id = ?
    ORDER BY rp.ts
  `).all(campaignId);

  const readingsCo2 = db.prepare(`
    SELECT rc.ts, rc.co2_ppm, rc.temperature_c, rc.humidity_pct,
      cs.name AS sensor_name, cs.friendly_name AS sensor_friendly_name
    FROM readings_co2 rc
    JOIN co2_sensors cs ON cs.id = rc.sensor_id
    WHERE rc.campaign_id = ?
    ORDER BY rc.ts
  `).all(campaignId);

  return {
    campaign: [{
      id: campaign.id,
      household: campaign.household,
      address: campaign.address || '',
      start_date: campaign.start_date,
      completed_at: campaign.completed_at || '',
      expected_days: campaign.expected_days,
      status: campaign.status,
      notes: campaign.notes || '',
    }],
    rooms,
    temp_sensors: tempSensors,
    plugs,
    readings_temp: readingsTemp,
    readings_power: readingsPower,
    readings_co2: readingsCo2,
  };
}

// GET /:campaignId/csv — export ZIP en streaming
router.get('/:campaignId/csv', (req, res) => {
  const db = getDb();
  const campaignId = req.params.campaignId;
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);

  if (!campaign) {
    return res.status(404).json({ error: 'Campagne introuvable' });
  }
  if (req.user.role !== 'admin' && campaign.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Acces interdit' });
  }

  const household = (campaign.household || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const date = new Date().toISOString().slice(0, 10);
  const filename = `beaba_${household}_${date}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  let failed = false;
  archive.on('error', err => {
    failed = true;
    console.error('[Export] Erreur archive :', err.message);
    if (!res.headersSent) res.status(500).end();
    else res.destroy(err);
  });

  // Archive entierement envoyee : la campagne peut etre effacee
  // (DELETE /api/campaign/:id exige archived_at >= completed_at).
  res.on('finish', () => {
    if (failed) return;
    db.prepare("UPDATE campaigns SET archived_at = datetime('now') WHERE id = ?").run(campaignId);
  });
  archive.pipe(res);

  // Petites tables : en memoire
  archive.append(BOM + toCsv([{
    id: campaign.id,
    household: campaign.household,
    address: campaign.address || '',
    start_date: campaign.start_date,
    completed_at: campaign.completed_at || '',
    expected_days: campaign.expected_days,
    status: campaign.status,
    notes: campaign.notes || '',
  }]), { name: 'donnees/campagne.csv' });

  const rooms = db.prepare(
    'SELECT id, name, color, sort_order FROM rooms WHERE campaign_id = ? ORDER BY sort_order, name'
  ).all(campaignId);
  archive.append(BOM + toCsv(rooms), { name: 'donnees/pieces.csv' });

  const tempSensors = db.prepare(`
    SELECT ts.id, ts.name, ts.friendly_name, ts.comment,
      COALESCE(r.name, '') AS room_name
    FROM temp_sensors ts
    LEFT JOIN rooms r ON r.id = ts.room_id
    WHERE ts.campaign_id = ?
    ORDER BY ts.name
  `).all(campaignId);
  archive.append(BOM + toCsv(tempSensors), { name: 'donnees/capteurs_temp.csv' });

  const plugs = db.prepare(`
    SELECT p.id, p.source, p.appliance_name, p.rated_power_w, p.sort_order,
      COALESCE(r.name, '') AS room_name
    FROM plugs p
    LEFT JOIN rooms r ON r.id = p.room_id
    WHERE p.campaign_id = ?
    ORDER BY p.sort_order
  `).all(campaignId);
  archive.append(BOM + toCsv(plugs), { name: 'donnees/prises.csv' });

  // Grosses tables : streaming via .iterate()
  archive.append(csvStreamFromIterator(db.prepare(`
    SELECT rt.ts, rt.temperature_c, rt.humidity_pct, rt.battery_pct,
      ts.name AS sensor_name, ts.friendly_name AS sensor_friendly_name
    FROM readings_temp rt
    JOIN temp_sensors ts ON ts.id = rt.sensor_id
    WHERE rt.campaign_id = ?
    ORDER BY rt.ts
  `).iterate(campaignId)), { name: 'donnees/releves_temperature.csv' });

  archive.append(csvStreamFromIterator(db.prepare(`
    SELECT rp.ts, rp.power_w, rp.energy_kwh,
      p.appliance_name, COALESCE(r.name, '') AS room_name
    FROM readings_power rp
    JOIN plugs p ON p.id = rp.plug_id
    LEFT JOIN rooms r ON r.id = p.room_id
    WHERE rp.campaign_id = ?
    ORDER BY rp.ts
  `).iterate(campaignId)), { name: 'donnees/releves_puissance.csv' });

  archive.append(csvStreamFromIterator(db.prepare(`
    SELECT rc.ts, rc.co2_ppm, rc.temperature_c, rc.humidity_pct,
      cs.name AS sensor_name, cs.friendly_name AS sensor_friendly_name
    FROM readings_co2 rc
    JOIN co2_sensors cs ON cs.id = rc.sensor_id
    WHERE rc.campaign_id = ?
    ORDER BY rc.ts
  `).iterate(campaignId)), { name: 'donnees/releves_co2.csv' });

  try {
    const report = generateReport(campaignId);
    if (report) {
      archive.append(JSON.stringify(report, null, 2), { name: 'rapport.json' });
    }
  } catch (err) {
    console.error('[Export] Erreur generation rapport :', err.message);
  }

  const readme = `Archive Beaba — ${campaign.household}
Date d'export : ${new Date().toLocaleDateString('fr-FR')}

Contenu :
- donnees/ : fichiers CSV des releves bruts (ouvrables avec Excel)
- rapport.json : rapport aggrege (statistiques, top consommateurs, confort)

Pour le rapport PDF :
1. Connectez-vous sur https://beaba.450ppm.be
2. Sur la page du rapport, cliquez sur "Telecharger PDF"
3. Imprimez la page en choisissant "Enregistrer en PDF"

Beaba — Comprendre son habitat
https://450ppm.be
`;
  archive.append(readme, { name: 'LISEZ-MOI.txt' });

  archive.finalize();
});

// GET /:campaignId/json — export JSON
router.get('/:campaignId/json', (req, res) => {
  const db = getDb();
  const data = loadExportData(db, req.params.campaignId);

  if (!data) {
    return res.status(404).json({ error: 'Campagne introuvable' });
  }

  const household = data.campaign[0].household.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `beaba_export_${household}.json`;

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.json(data);
});

module.exports = router;
