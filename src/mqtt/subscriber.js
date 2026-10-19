/**
 * beaba — mqtt/subscriber.js
 * S'abonne a zigbee2mqtt et insere les releves en SQLite.
 *
 * Topics ecoutes :
 *   zigbee2mqtt/<friendly_name>  →  SNZB-02P, Innr, Heiman HS3AQ
 *   zigbee2mqtt/bridge/state     →  sante du bridge
 *   zigbee2mqtt/bridge/devices   →  liste des devices (discovery)
 *   zigbee2mqtt/bridge/info      →  version, appairage ouvert ou non
 *   zigbee2mqtt/bridge/event     →  appareil rejoint / interview
 */

'use strict';
const mqtt = require('mqtt');
const { getDb, getActiveCampaign } = require('../db');

let client = null;
let _activeCampaign = null;
let _campaignCheckTimer = null;
let _deviceList = [];

// Activite par appareil (friendly_name), campagne ou pas :
// { last_seen, linkquality, battery, availability }. Sert a l'apercu
// du reseau Zigbee pour reperer un capteur appaire mais non declare.
const _activity = {};

// Etat du bridge pour l'appairage a distance : { version, permit_join,
// permit_join_end (ISO) } et derniers evenements de jonction.
let _bridge = { version: null, permit_join: false, permit_join_end: null };
const _joinEvents = [];
const MAX_JOIN_EVENTS = 20;
let _pendingPermitJoin = null;

// Cache anti-doublons : stocke le dernier {value, timestamp} par capteur/prise
const _lastValues = {};

// ── Accesseurs device discovery ──────────────────────────────────────

function getDevices() {
  return _deviceList;
}

function getActivity() {
  return _activity;
}

function getBridge() {
  // L'echeance peut etre passee si bridge/info n'a pas ete republie
  const expired = _bridge.permit_join_end && new Date(_bridge.permit_join_end) < new Date();
  return { ..._bridge, permit_join: _bridge.permit_join && !expired, events: _joinEvents };
}

// Ouvre (seconds > 0) ou ferme (0) l'appairage. Le payload porte value
// et time pour fonctionner avec zigbee2mqtt 1.x comme 2.x. Resout avec
// la reponse du bridge, ou { status: 'timeout' } apres 5 s.
function permitJoin(seconds) {
  if (!client || !client.connected) {
    return Promise.resolve({ status: 'error', error: 'MQTT non connecte' });
  }
  if (_pendingPermitJoin) _pendingPermitJoin({ status: 'superseded' });
  // Nouvelle session d'appairage : on ne montre que ses evenements
  if (seconds > 0) _joinEvents.length = 0;
  return new Promise((resolve) => {
    const timer = setTimeout(() => done({ status: 'timeout' }), 5000);
    function done(res) {
      clearTimeout(timer);
      if (_pendingPermitJoin === done) _pendingPermitJoin = null;
      // bridge/info suit normalement et corrige l'echeance si besoin
      if (res.status === 'ok') {
        _bridge = {
          ..._bridge,
          permit_join: seconds > 0,
          permit_join_end: seconds > 0 ? new Date(Date.now() + seconds * 1000).toISOString() : null,
        };
      }
      resolve(res);
    }
    _pendingPermitJoin = done;
    client.publish('zigbee2mqtt/bridge/request/permit_join',
      JSON.stringify({ value: seconds > 0, time: seconds }));
  });
}

function handleBridgeInfo(info) {
  let end = null;
  if (info.permit_join_end) end = new Date(info.permit_join_end).toISOString();                 // 2.x
  else if (info.permit_join_timeout) end = new Date(Date.now() + info.permit_join_timeout * 1000).toISOString(); // 1.x
  _bridge = { version: info.version || _bridge.version, permit_join: !!info.permit_join, permit_join_end: info.permit_join ? end : null };
}

function handleBridgeEvent(evt) {
  const { type, data = {} } = evt;
  if (type !== 'device_joined' && type !== 'device_interview' && type !== 'device_announce') return;
  _joinEvents.unshift({
    ts: new Date().toISOString(),
    type,
    status: data.status || null,
    friendly_name: data.friendly_name || null,
    ieee_address: data.ieee_address || null,
    model: data.definition?.model || null,
    vendor: data.definition?.vendor || null,
  });
  _joinEvents.length = Math.min(_joinEvents.length, MAX_JOIN_EVENTS);
  if (type === 'device_interview' && data.status === 'successful') requestDevices();
}

function requestDevices() {
  if (client && client.connected) {
    client.publish('zigbee2mqtt/bridge/request/devices', '');
  }
}

// ── Handlers par type de capteur ─────────────────────────────────────

// Verifie si on doit enregistrer (evite les doublons)
function shouldRecord(key, value) {
  const now = Date.now();
  const last = _lastValues[key];
  if (!last) {
    _lastValues[key] = { value, ts: now };
    return true;
  }
  // Enregistrer si la valeur a change OU si plus de 25s se sont ecoulees
  if (value !== last.value || (now - last.ts) > 25000) {
    _lastValues[key] = { value, ts: now };
    return true;
  }
  return false;
}

function handleTempSensor(db, sensorId, campaignId, payload) {
  const { temperature, humidity, battery } = payload;
  if (temperature == null || humidity == null) return;

  if (!shouldRecord(`temp_${sensorId}`, `${temperature}_${humidity}`)) return;

  db.prepare(`
    INSERT INTO readings_temp (sensor_id, campaign_id, temperature_c, humidity_pct, battery_pct)
    VALUES (?, ?, ?, ?, ?)
  `).run(sensorId, campaignId, temperature, humidity, battery ?? null);
}

function handleCo2Sensor(db, sensorId, campaignId, payload) {
  const { co2, temperature, humidity } = payload;
  if (co2 == null) return;

  if (!shouldRecord(`co2_${sensorId}`, `${co2}_${temperature}`)) return;

  db.prepare(`
    INSERT INTO readings_co2 (sensor_id, campaign_id, co2_ppm, temperature_c, humidity_pct)
    VALUES (?, ?, ?, ?, ?)
  `).run(sensorId, campaignId, co2, temperature ?? null, humidity ?? null);
}

function handlePlug(db, plugId, campaignId, payload) {
  const { power, energy } = payload;
  if (power == null) return;

  if (!shouldRecord(`power_${plugId}`, power)) return;

  db.prepare(`
    INSERT INTO readings_power (plug_id, campaign_id, power_w, energy_kwh)
    VALUES (?, ?, ?, ?)
  `).run(plugId, campaignId, power, energy ?? null);
}

// Cree un capteur CO2 (sans piece) pour un device qui publie du CO2 sans
// avoir ete declare. L'id reprend l'adresse IEEE comme dans le SetupWizard,
// sauf si elle est deja prise par une autre campagne : on ne la deplace pas
// pour ne pas orpheliner les releves de cette campagne-la.
function autoRegisterCo2Sensor(db, friendlyName, campaignId) {
  const device = _deviceList.find((d) => d.friendly_name === friendlyName);
  let id = device?.ieee_address || friendlyName;
  const taken = db.prepare('SELECT campaign_id FROM co2_sensors WHERE id = ?').get(id);
  if (taken && taken.campaign_id !== campaignId) id = `${id}_${campaignId.slice(0, 8)}`;

  db.prepare(`
    INSERT OR IGNORE INTO co2_sensors (id, campaign_id, room_id, name, friendly_name, comment)
    VALUES (?, ?, NULL, ?, ?, ?)
  `).run(id, campaignId, friendlyName, friendlyName, 'Ajoute automatiquement (non declare au setup)');

  console.warn(`[MQTT] Capteur CO2 "${friendlyName}" non declare : cree automatiquement (${id}), a affecter a une piece`);
  return db.prepare('SELECT id FROM co2_sensors WHERE friendly_name = ? AND campaign_id = ?').get(friendlyName, campaignId);
}

// ── Routage par friendly_name ─────────────────────────────────────────

function route(db, friendlyName, payload, campaignId) {
  // Tout message portant du CO2 va vers un capteur CO2, declare ou non :
  // un capteur oublie au setup ne doit plus faire perdre la campagne.
  if (payload.co2 != null) {
    const co2Sensor = db.prepare(
      'SELECT id FROM co2_sensors WHERE friendly_name = ? AND campaign_id = ?'
    ).get(friendlyName, campaignId) || autoRegisterCo2Sensor(db, friendlyName, campaignId);
    return handleCo2Sensor(db, co2Sensor.id, campaignId, payload);
  }

  // Capteurs temperature
  const tempSensor = db.prepare(
    'SELECT id FROM temp_sensors WHERE friendly_name = ? AND campaign_id = ?'
  ).get(friendlyName, campaignId);
  if (tempSensor) return handleTempSensor(db, tempSensor.id, campaignId, payload);

  // Prises Innr
  const plug = db.prepare(
    "SELECT id FROM plugs WHERE zigbee_id = ? AND campaign_id = ? AND source = 'innr'"
  ).get(friendlyName, campaignId);
  if (plug) return handlePlug(db, plug.id, campaignId, payload);
}

// ── Demarrage du subscriber ───────────────────────────────────────────

function start() {
  const db = getDb();
  const brokerUrl = process.env.MQTT_BROKER || 'mqtt://localhost:1883';

  // Charger la campagne active au demarrage
  _activeCampaign = getActiveCampaign();

  // Re-verifier periodiquement (toutes les 30s) si une campagne est devenue active
  _campaignCheckTimer = setInterval(() => {
    _activeCampaign = getActiveCampaign();
  }, 30_000);

  const opts = {};
  if (process.env.MQTT_USERNAME) opts.username = process.env.MQTT_USERNAME;
  if (process.env.MQTT_PASSWORD) opts.password = process.env.MQTT_PASSWORD;

  client = mqtt.connect(brokerUrl, opts);

  client.on('connect', () => {
    console.log(`[MQTT] Connecte a ${brokerUrl}`);
    client.subscribe('zigbee2mqtt/#', (err) => {
      if (err) console.error('[MQTT] Erreur subscribe :', err.message);
      else console.log('[MQTT] Abonne a zigbee2mqtt/#');
    });
  });

  client.on('message', (topic, raw) => {
    // Bridge state
    if (topic === 'zigbee2mqtt/bridge/state') {
      console.log('[MQTT] Bridge :', raw.toString());
      return;
    }

    // Device discovery
    if (topic === 'zigbee2mqtt/bridge/devices') {
      try {
        _deviceList = JSON.parse(raw.toString());
        console.log(`[MQTT] Device list mise a jour : ${_deviceList.length} devices`);
      } catch { /* ignore */ }
      return;
    }

    // Appairage : etat, evenements, reponse a nos demandes
    if (topic === 'zigbee2mqtt/bridge/info' || topic === 'zigbee2mqtt/bridge/event'
        || topic === 'zigbee2mqtt/bridge/response/permit_join') {
      try {
        const msg = JSON.parse(raw.toString());
        if (topic.endsWith('/info')) handleBridgeInfo(msg);
        else if (topic.endsWith('/event')) handleBridgeEvent(msg);
        else if (_pendingPermitJoin) _pendingPermitJoin({ status: msg.status, error: msg.error || null });
      } catch { /* ignore */ }
      return;
    }

    // Ignore les autres topics bridge
    if (topic.startsWith('zigbee2mqtt/bridge/')) return;

    const friendlyName = topic.replace('zigbee2mqtt/', '');

    // Disponibilite (si activee dans zigbee2mqtt) : "online" | {"state":"online"}
    if (friendlyName.endsWith('/availability')) {
      const name = friendlyName.slice(0, -'/availability'.length);
      const txt = raw.toString();
      let state = txt;
      try { state = JSON.parse(txt).state ?? txt; } catch { /* texte brut */ }
      _activity[name] = { ..._activity[name], availability: state };
      return;
    }

    // Nos propres requetes /get et /set reviennent par l'abonnement '#'
    if (/\/(get|set)(\/.*)?$/.test(friendlyName)) return;

    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!payload || typeof payload !== 'object') return;

    _activity[friendlyName] = {
      ..._activity[friendlyName],
      last_seen: new Date().toISOString(),
      linkquality: payload.linkquality ?? _activity[friendlyName]?.linkquality ?? null,
      battery: payload.battery ?? _activity[friendlyName]?.battery ?? null,
    };

    // Pas de campagne active → on ne stocke rien
    if (!_activeCampaign || _activeCampaign.status !== 'active') return;

    try {
      route(db, friendlyName, payload, _activeCampaign.id);
    } catch (err) {
      console.error(`[MQTT] Erreur route ${friendlyName} :`, err.message);
    }
  });

  client.on('error', (err) => {
    console.error('[MQTT] Erreur client :', err.message);
  });

  client.on('offline', () => {
    console.warn('[MQTT] Client offline — tentative de reconnexion...');
  });
}

function stop() {
  if (_campaignCheckTimer) clearInterval(_campaignCheckTimer);
  if (client) client.end();
}

function getClient() { return client; }

module.exports = {
  start, stop, getClient, getDevices, getActivity, getBridge, permitJoin, requestDevices,
};
