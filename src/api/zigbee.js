/**
 * beaba — api/zigbee.js
 * Expose la liste des devices zigbee2mqtt via le subscriber MQTT, et un
 * apercu du reseau qui la croise avec les declarations de la campagne.
 */

'use strict';
const { Router } = require('express');
const { getDb, getActiveCampaign } = require('../db');
const { requirePairing } = require('./middleware');
const {
  getDevices, getActivity, getBridge, permitJoin, requestDevices,
} = require('../mqtt/subscriber');

const router = Router();

// Au-dela de ce delai sans message, un appareil est considere muet
// (meme seuil que /api/sensors/health).
const SILENT_AFTER_MIN = 60;

// Type d'appareil deduit des "exposes" zigbee2mqtt.
function deviceKind(device) {
  const names = new Set();
  const walk = (list) => (list || []).forEach((e) => {
    if (e.property) names.add(e.property);
    if (e.name) names.add(e.name);
    walk(e.features);
  });
  walk(device.definition?.exposes);
  if (names.has('co2')) return 'co2';
  if (names.has('power')) return 'plug';
  if (names.has('temperature')) return 'temp';
  return 'other';
}

// SQLite datetime('now') -> ISO UTC
const sqlToIso = (ts) => (ts ? `${ts.replace(' ', 'T')}Z` : null);

const latest = (...isos) => isos.filter(Boolean).sort().pop() || null;

// Campagne de reference : celle en cours, sinon la plus recente.
function referenceCampaign(user) {
  const userId = user.role !== 'admin' ? user.id : null;
  const current = getActiveCampaign(userId);
  if (current) return current;
  const db = getDb();
  return userId
    ? db.prepare('SELECT * FROM campaigns WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(userId) || null
    : db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC LIMIT 1').get() || null;
}

// Appareils declares dans la campagne, indexes par friendly_name.
function declaredDevices(db, campaignId) {
  const rows = [
    ...db.prepare(`
      SELECT 'temp' AS kind, s.friendly_name, s.name, r.name AS room,
             (SELECT MAX(x.ts) FROM readings_temp x WHERE x.sensor_id = s.id) AS last_ts
      FROM temp_sensors s LEFT JOIN rooms r ON r.id = s.room_id
      WHERE s.campaign_id = ?`).all(campaignId),
    ...db.prepare(`
      SELECT 'co2' AS kind, s.friendly_name, s.name, r.name AS room,
             (SELECT MAX(x.ts) FROM readings_co2 x WHERE x.sensor_id = s.id) AS last_ts
      FROM co2_sensors s LEFT JOIN rooms r ON r.id = s.room_id
      WHERE s.campaign_id = ?`).all(campaignId),
    ...db.prepare(`
      SELECT 'plug' AS kind, p.zigbee_id AS friendly_name, p.appliance_name AS name, r.name AS room,
             (SELECT MAX(x.ts) FROM readings_power x WHERE x.plug_id = p.id) AS last_ts
      FROM plugs p LEFT JOIN rooms r ON r.id = p.room_id
      WHERE p.campaign_id = ? AND p.source = 'innr' AND p.zigbee_id IS NOT NULL`).all(campaignId),
  ];
  return new Map(rows.map((d) => [d.friendly_name, d]));
}

// GET /devices — liste des devices zigbee2mqtt (cache)
router.get('/devices', (req, res) => {
  res.json(getDevices());
});

// GET /overview — chaque appareil du reseau, avec son statut :
//   ok         : appaire, declare, actif
//   undeclared : appaire mais pas declare (ses mesures sont ignorees,
//                sauf CO2 qui est auto-enregistre sans piece)
//   missing    : declare mais plus appaire au reseau
//   silent     : appaire mais aucun message depuis SILENT_AFTER_MIN
//   waiting    : aucun message recu depuis le demarrage du backend recent
router.get('/overview', (req, res) => {
  const db = getDb();
  const campaign = referenceCampaign(req.user);
  const declared = campaign ? declaredDevices(db, campaign.id) : new Map();
  const devices = getDevices().filter((d) => d.type !== 'Coordinator');
  const activity = getActivity();
  const listKnown = getDevices().length > 0;
  const silentBefore = new Date(Date.now() - SILENT_AFTER_MIN * 60000).toISOString();
  const upLongEnough = process.uptime() > SILENT_AFTER_MIN * 60;

  const statusOf = ({ paired, decl, lastSeen }) => {
    if (!paired) return 'missing';
    if (!decl) return 'undeclared';
    if (!lastSeen) return upLongEnough ? 'silent' : 'waiting';
    return lastSeen < silentBefore ? 'silent' : 'ok';
  };

  const result = devices.map((d) => {
    const act = activity[d.friendly_name] || {};
    const decl = declared.get(d.friendly_name) || null;
    const lastSeen = latest(act.last_seen, sqlToIso(decl?.last_ts));
    const item = {
      friendly_name: d.friendly_name,
      ieee_address: d.ieee_address,
      model: d.definition?.model || d.model_id || null,
      vendor: d.definition?.vendor || d.manufacturer || null,
      description: d.definition?.description || null,
      kind: decl?.kind || deviceKind(d),
      zigbee_type: d.type || null,
      power_source: d.power_source || null,
      paired: true,
      declared: decl ? { name: decl.name, room: decl.room || null, as: decl.kind } : null,
      last_seen: lastSeen,
      linkquality: act.linkquality ?? null,
      battery: act.battery ?? null,
      availability: act.availability || null,
    };
    item.status = statusOf({ paired: true, decl, lastSeen });
    return item;
  });

  // Appareils declares mais absents de la liste zigbee2mqtt
  if (listKnown) {
    const paired = new Set(devices.map((d) => d.friendly_name));
    declared.forEach((decl, name) => {
      if (paired.has(name)) return;
      result.push({
        friendly_name: name,
        ieee_address: null, model: null, vendor: null, description: null,
        kind: decl.kind, zigbee_type: null, power_source: null,
        paired: false,
        declared: { name: decl.name, room: decl.room || null, as: decl.kind },
        last_seen: sqlToIso(decl.last_ts),
        linkquality: null, battery: null, availability: null,
        status: 'missing',
      });
    });
  }

  const order = { missing: 0, undeclared: 1, silent: 2, waiting: 3, ok: 4 };
  result.sort((a, b) => order[a.status] - order[b.status]
    || a.kind.localeCompare(b.kind) || a.friendly_name.localeCompare(b.friendly_name));

  const counts = result.reduce((acc, d) => ({ ...acc, [d.status]: (acc[d.status] || 0) + 1 }), {});

  res.json({
    campaign: campaign ? { id: campaign.id, household: campaign.household, status: campaign.status } : null,
    list_known: listKnown,
    silent_after_min: SILENT_AFTER_MIN,
    backend_uptime_s: Math.round(process.uptime()),
    counts,
    bridge: getBridge(),
    devices: result,
  });
});

// POST /permit-join { seconds } — ouvre l'appairage a distance pour qu'une
// personne sur place appuie sur le bouton du capteur. seconds = 0 ferme.
const MAX_PERMIT_JOIN_S = 254;
router.post('/permit-join', requirePairing, async (req, res) => {
  const seconds = Math.max(0, Math.min(MAX_PERMIT_JOIN_S, parseInt(req.body?.seconds, 10) || 0));
  const result = await permitJoin(seconds);
  if (result.status === 'ok') return res.json({ ok: true, seconds, bridge: getBridge() });
  if (result.status === 'timeout') {
    return res.status(504).json({ error: "zigbee2mqtt n'a pas repondu. Est-il demarre ?" });
  }
  res.status(502).json({ error: result.error || "zigbee2mqtt a refuse la demande d'appairage" });
});

// POST /devices/refresh — demander une mise a jour de la liste
router.post('/devices/refresh', (req, res) => {
  requestDevices();
  res.json({ ok: true, message: 'Demande envoyee' });
});

module.exports = router;
