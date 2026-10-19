/**
 * beaba — mqtt/subscriber.js
 * S'abonne a zigbee2mqtt et insere les releves en SQLite.
 *
 * Topics ecoutes :
 *   zigbee2mqtt/<friendly_name>  →  SNZB-02P, Innr, Heiman HS3AQ
 *   zigbee2mqtt/bridge/state     →  sante du bridge
 *   zigbee2mqtt/bridge/devices   →  liste des devices (discovery)
 */

'use strict';
const mqtt = require('mqtt');
const { getDb, getActiveCampaign } = require('../db');

let client = null;
let _activeCampaign = null;
let _campaignCheckTimer = null;
let _deviceList = [];

// Cache anti-doublons : stocke le dernier {value, timestamp} par capteur/prise
const _lastValues = {};

// ── Accesseurs device discovery ──────────────────────────────────────

function getDevices() {
  return _deviceList;
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

    // Ignore les autres topics bridge
    if (topic.startsWith('zigbee2mqtt/bridge/')) return;

    // Pas de campagne active → on ne stocke rien
    if (!_activeCampaign || _activeCampaign.status !== 'active') return;

    const friendlyName = topic.replace('zigbee2mqtt/', '');

    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      return;
    }

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

module.exports = { start, stop, getClient, getDevices, requestDevices };
