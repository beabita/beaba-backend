/**
 * beaba -- report/generator.js
 * Genere les donnees du rapport pour une campagne donnee.
 */

'use strict';
const { getDb } = require('../db');

const ELECTRICITY_RATE = parseFloat(process.env.ELECTRICITY_RATE || '0.2516');

/**
 * Genere un rapport complet pour une campagne.
 * @param {string} campaignId
 * @returns {object} rapport
 */
function generateReport(campaignId) {
  const db = getDb();

  // ── Campagne ────────────────────────────────────────────────────────
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  if (!campaign) return null;

  const startDate = campaign.start_date;
  const endDate = campaign.completed_at || new Date().toISOString().slice(0, 19).replace('T', ' ');
  const durationMs = new Date(endDate) - new Date(startDate);
  const durationDays = Math.max(1, Math.round(durationMs / (1000 * 60 * 60 * 24)));

  // ── Compteurs (releves debut/fin) ───────────────────────────────────
  const meters = computeMeters(db, campaignId);

  // ── Energie ─────────────────────────────────────────────────────────
  const energy = computeEnergy(db, campaignId, durationDays);

  // ── Top consommateurs ───────────────────────────────────────────────
  const topConsumers = computeTopConsumers(db, campaignId, energy.total_kwh);

  // ── Veille ──────────────────────────────────────────────────────────
  const standby = computeStandby(db, campaignId);

  // ── Confort ─────────────────────────────────────────────────────────
  const comfort = computeComfort(db, campaignId);

  // ── Qualite d'air (CO2) ─────────────────────────────────────────────
  const airQuality = computeAirQuality(db, campaignId);

  // ── Recommandations ─────────────────────────────────────────────────
  const recommendations = generateRecommendations(topConsumers, standby, comfort, energy, airQuality);

  return {
    campaign: {
      id: campaign.id,
      household: campaign.household,
      address: campaign.address,
      start_date: startDate,
      end_date: endDate,
      duration_days: durationDays,
      status: campaign.status,
    },
    meters,
    energy,
    top_consumers: topConsumers,
    standby,
    comfort,
    air_quality: airQuality,
    recommendations,
  };
}

const GAS_RATE = parseFloat(process.env.GAS_RATE || '0.12');
const WATER_RATE = parseFloat(process.env.WATER_RATE || '4.0');
const GAS_KWH_PER_M3 = 11.16;

/**
 * Calcule la consommation a partir des releves compteurs (debut/fin).
 */
function computeMeters(db, campaignId) {
  const readings = db.prepare(
    'SELECT * FROM meter_readings WHERE campaign_id = ? ORDER BY meter_type, phase'
  ).all(campaignId);

  const types = ['electricity', 'gas', 'water'];
  const result = [];
  let totalCost = 0;

  for (const type of types) {
    const startReading = readings.find(r => r.meter_type === type && r.phase === 'start');
    const endReading = readings.find(r => r.meter_type === type && r.phase === 'end');

    if (!startReading || !endReading) continue;

    const consumption = Math.round((endReading.value - startReading.value) * 100) / 100;

    let cost = 0;
    let consumptionKwh = null;
    if (type === 'electricity') {
      cost = Math.round(consumption * ELECTRICITY_RATE * 100) / 100;
      consumptionKwh = consumption;
    } else if (type === 'gas') {
      consumptionKwh = Math.round(consumption * GAS_KWH_PER_M3 * 100) / 100;
      cost = Math.round(consumptionKwh * GAS_RATE * 100) / 100;
    } else if (type === 'water') {
      cost = Math.round(consumption * WATER_RATE * 100) / 100;
    }

    totalCost += cost;

    result.push({
      meter_type: type,
      start_value: startReading.value,
      end_value: endReading.value,
      unit: startReading.unit,
      consumption,
      consumption_kwh: consumptionKwh,
      estimated_cost: cost,
    });
  }

  return {
    readings: result,
    total_estimated_cost: Math.round(totalCost * 100) / 100,
  };
}

/**
 * Calcule la consommation energetique totale et la serie quotidienne.
 */
function computeEnergy(db, campaignId, durationDays) {
  // Verifier si on a des energy_kwh (Innr) — delta par jour
  const hasEnergyKwh = db.prepare(
    'SELECT COUNT(*) AS cnt FROM readings_power WHERE campaign_id = ? AND energy_kwh IS NOT NULL'
  ).get(campaignId).cnt;

  let dailySeries;
  let totalKwh;

  if (hasEnergyKwh > 10) {
    // Utiliser energy_kwh corrige par l'offset de debut de campagne
    // Conso reelle = energy_kwh_actuel - energy_offset_kwh
    dailySeries = db.prepare(`
      SELECT day_date AS date,
        SUM(day_kwh) AS kwh
      FROM (
        SELECT rp.plug_id, date(rp.ts) AS day_date,
          MAX(rp.energy_kwh - COALESCE(p.energy_offset_kwh, 0))
          - MIN(rp.energy_kwh - COALESCE(p.energy_offset_kwh, 0)) AS day_kwh
        FROM readings_power rp
        JOIN plugs p ON p.id = rp.plug_id
        WHERE rp.campaign_id = ? AND rp.energy_kwh IS NOT NULL
        GROUP BY rp.plug_id, date(rp.ts)
      )
      GROUP BY date
      ORDER BY date
    `).all(campaignId);
  } else {
    // Estimation via power_w : on suppose chaque releve represente la puissance
    // jusqu'au releve suivant. On integre par jour.
    dailySeries = db.prepare(`
      SELECT date(ts) AS date,
        SUM(power_w * interval_h) / 1000.0 AS kwh
      FROM (
        SELECT ts, power_w,
          CAST(
            MIN(
              (julianday(LEAD(ts) OVER (PARTITION BY plug_id ORDER BY ts)) - julianday(ts)) * 24,
              1.0
            ) AS REAL
          ) AS interval_h
        FROM readings_power
        WHERE campaign_id = ?
      )
      WHERE interval_h IS NOT NULL AND interval_h > 0
      GROUP BY date
      ORDER BY date
    `).all(campaignId);
  }

  totalKwh = dailySeries.reduce((sum, d) => sum + (d.kwh || 0), 0);
  const dailyAvgKwh = durationDays > 0 ? totalKwh / durationDays : 0;

  return {
    total_kwh: Math.round(totalKwh * 100) / 100,
    estimated_cost: Math.round(totalKwh * ELECTRICITY_RATE * 100) / 100,
    daily_avg_kwh: Math.round(dailyAvgKwh * 100) / 100,
    daily_series: dailySeries.map(d => ({
      date: d.date,
      kwh: Math.round((d.kwh || 0) * 100) / 100,
    })),
  };
}

/**
 * Identifie les plus gros consommateurs.
 */
function computeTopConsumers(db, campaignId, totalKwh) {
  // Verifier si on a energy_kwh
  const hasEnergyKwh = db.prepare(
    'SELECT COUNT(*) AS cnt FROM readings_power WHERE campaign_id = ? AND energy_kwh IS NOT NULL'
  ).get(campaignId).cnt;

  let rows;

  if (hasEnergyKwh > 10) {
    rows = db.prepare(`
      SELECT p.id AS plug_id, p.appliance_name,
        COALESCE(r.name, '') AS room_name,
        SUM(day_kwh) AS total_kwh
      FROM (
        SELECT rp.plug_id,
          MAX(rp.energy_kwh - COALESCE(p2.energy_offset_kwh, 0))
          - MIN(rp.energy_kwh - COALESCE(p2.energy_offset_kwh, 0)) AS day_kwh
        FROM readings_power rp
        JOIN plugs p2 ON p2.id = rp.plug_id
        WHERE rp.campaign_id = ? AND rp.energy_kwh IS NOT NULL
        GROUP BY rp.plug_id, date(rp.ts)
      ) sub
      JOIN plugs p ON p.id = sub.plug_id
      LEFT JOIN rooms r ON r.id = p.room_id
      GROUP BY p.id
      ORDER BY total_kwh DESC
    `).all(campaignId);
  } else {
    rows = db.prepare(`
      SELECT p.id AS plug_id, p.appliance_name,
        COALESCE(r.name, '') AS room_name,
        SUM(rp.power_w * interval_h) / 1000.0 AS total_kwh
      FROM (
        SELECT id, plug_id, power_w,
          CAST(
            MIN(
              (julianday(LEAD(ts) OVER (PARTITION BY plug_id ORDER BY ts)) - julianday(ts)) * 24,
              1.0
            ) AS REAL
          ) AS interval_h
        FROM readings_power
        WHERE campaign_id = ?
      ) rp
      JOIN plugs p ON p.id = rp.plug_id
      LEFT JOIN rooms r ON r.id = p.room_id
      WHERE rp.interval_h IS NOT NULL AND rp.interval_h > 0
      GROUP BY p.id
      ORDER BY total_kwh DESC
    `).all(campaignId);
  }

  return rows.map(r => ({
    plug_id: r.plug_id,
    appliance_name: r.appliance_name,
    room_name: r.room_name,
    total_kwh: Math.round((r.total_kwh || 0) * 100) / 100,
    percentage: totalKwh > 0
      ? Math.round(((r.total_kwh || 0) / totalKwh) * 10000) / 100
      : 0,
  }));
}

/**
 * Detecte la consommation en veille (avg power > 1W entre 0h et 6h).
 */
function computeStandby(db, campaignId) {
  const rows = db.prepare(`
    SELECT p.id AS plug_id, p.appliance_name,
      AVG(rp.power_w) AS avg_power_w
    FROM readings_power rp
    JOIN plugs p ON p.id = rp.plug_id
    WHERE rp.campaign_id = ?
      AND CAST(strftime('%H', rp.ts) AS INTEGER) BETWEEN 0 AND 5
    GROUP BY p.id
    HAVING AVG(rp.power_w) > 1
    ORDER BY avg_power_w DESC
  `).all(campaignId);

  return rows.map(r => {
    const avgW = Math.round(r.avg_power_w * 10) / 10;
    const annualKwh = Math.round(avgW * 8760 / 1000 * 100) / 100;
    const annualCost = Math.round(annualKwh * ELECTRICITY_RATE * 100) / 100;
    return {
      plug_id: r.plug_id,
      appliance_name: r.appliance_name,
      avg_power_w: avgW,
      estimated_annual_kwh: annualKwh,
      estimated_annual_cost: annualCost,
    };
  });
}

/**
 * Analyse le confort thermique par piece.
 */
function computeComfort(db, campaignId) {
  const rooms = db.prepare(
    'SELECT * FROM rooms WHERE campaign_id = ? ORDER BY sort_order, name'
  ).all(campaignId);

  return rooms.map(room => {
    const stats = db.prepare(`
      SELECT
        AVG(rt.temperature_c) AS avg_temp,
        MIN(rt.temperature_c) AS min_temp,
        MAX(rt.temperature_c) AS max_temp,
        AVG(rt.humidity_pct)  AS avg_humidity,
        COUNT(*) AS total,
        SUM(CASE WHEN rt.temperature_c < 19 OR rt.temperature_c > 24 THEN 1 ELSE 0 END) AS temp_outside,
        SUM(CASE WHEN rt.humidity_pct < 40 OR rt.humidity_pct > 60 THEN 1 ELSE 0 END) AS humidity_outside
      FROM readings_temp rt
      JOIN temp_sensors ts ON ts.id = rt.sensor_id
      WHERE rt.campaign_id = ? AND ts.room_id = ?
    `).get(campaignId, room.id);

    const total = stats.total || 1;
    const pctTempOutside = Math.round((stats.temp_outside || 0) / total * 100);
    const pctHumidityOutside = Math.round((stats.humidity_outside || 0) / total * 100);

    // Statut confort
    const pctOutside = Math.max(pctTempOutside, pctHumidityOutside);
    let status = 'good';
    if (pctOutside > 40) status = 'bad';
    else if (pctOutside > 15) status = 'warning';

    // Serie temperature quotidienne
    const dailyTempSeries = db.prepare(`
      SELECT date(rt.ts) AS date, AVG(rt.temperature_c) AS avg_temp
      FROM readings_temp rt
      JOIN temp_sensors ts ON ts.id = rt.sensor_id
      WHERE rt.campaign_id = ? AND ts.room_id = ?
      GROUP BY date(rt.ts)
      ORDER BY date(rt.ts)
    `).all(campaignId, room.id).map(d => ({
      date: d.date,
      avg_temp: Math.round((d.avg_temp || 0) * 10) / 10,
    }));

    return {
      room_id: room.id,
      room_name: room.name,
      color: room.color,
      avg_temp: stats.avg_temp != null ? Math.round(stats.avg_temp * 10) / 10 : null,
      min_temp: stats.min_temp != null ? Math.round(stats.min_temp * 10) / 10 : null,
      max_temp: stats.max_temp != null ? Math.round(stats.max_temp * 10) / 10 : null,
      avg_humidity: stats.avg_humidity != null ? Math.round(stats.avg_humidity * 10) / 10 : null,
      pct_temp_outside: pctTempOutside,
      pct_humidity_outside: pctHumidityOutside,
      status,
      daily_temp_series: dailyTempSeries,
    };
  });
}

// Seuils CO2 alignes sur le dashboard (SensorList) : < 800 bon, 800-1200 moyen.
const CO2_GOOD = 800;
const CO2_BAD = 1200;

/**
 * Analyse le CO2 par capteur (offset de calibration applique).
 * Les capteurs sans piece sont inclus : leurs releves ne doivent pas
 * disparaitre du rapport. `missing` signale une campagne sans aucun releve.
 */
function computeAirQuality(db, campaignId) {
  const sensors = db.prepare(`
    SELECT s.id AS sensor_id, s.name AS sensor_name, s.room_id,
      s.calibration_offset_ppm AS offset,
      r.name AS room_name, r.color, r.sort_order,
      COUNT(rc.id) AS total,
      AVG(rc.co2_ppm + s.calibration_offset_ppm) AS avg_co2,
      MAX(rc.co2_ppm + s.calibration_offset_ppm) AS max_co2,
      SUM(CASE WHEN rc.co2_ppm + s.calibration_offset_ppm >= ${CO2_GOOD} THEN 1 ELSE 0 END) AS over_good,
      SUM(CASE WHEN rc.co2_ppm + s.calibration_offset_ppm >= ${CO2_BAD} THEN 1 ELSE 0 END) AS over_bad
    FROM co2_sensors s
    LEFT JOIN rooms r ON r.id = s.room_id
    LEFT JOIN readings_co2 rc ON rc.sensor_id = s.id AND rc.campaign_id = s.campaign_id
    WHERE s.campaign_id = ?
    GROUP BY s.id
    ORDER BY r.sort_order IS NULL, r.sort_order, r.name, s.name
  `).all(campaignId);

  const rows = sensors.filter(s => s.total > 0).map(s => {
    const pctOverGood = Math.round(s.over_good / s.total * 100);
    const pctOverBad = Math.round(s.over_bad / s.total * 100);
    let status = 'good';
    if (pctOverBad > 10) status = 'bad';
    else if (pctOverGood > 25) status = 'warning';

    const daily = db.prepare(`
      SELECT date(rc.ts) AS date, AVG(rc.co2_ppm) AS avg_co2, MAX(rc.co2_ppm) AS max_co2
      FROM readings_co2 rc
      WHERE rc.sensor_id = ? AND rc.campaign_id = ?
      GROUP BY date(rc.ts)
      ORDER BY date(rc.ts)
    `).all(s.sensor_id, campaignId);

    return {
      sensor_id: s.sensor_id,
      sensor_name: s.sensor_name,
      room_id: s.room_id,
      room_name: s.room_name || 'Piece non renseignee',
      color: s.color,
      avg_co2: Math.round(s.avg_co2),
      max_co2: Math.round(s.max_co2),
      pct_over_800: pctOverGood,
      pct_over_1200: pctOverBad,
      status,
      daily_co2_series: daily.map(d => ({
        date: d.date,
        avg_co2: Math.round(d.avg_co2 + (s.offset || 0)),
        max_co2: Math.round(d.max_co2 + (s.offset || 0)),
      })),
    };
  });

  return {
    missing: rows.length === 0,
    silent_sensors: sensors.filter(s => s.total === 0).map(s => s.sensor_name),
    rooms: rows,
  };
}

/**
 * Genere des recommandations automatiques en francais.
 */
function generateRecommendations(topConsumers, standby, comfort, energy, airQuality) {
  const tips = [];

  // Veille
  if (standby.length > 0) {
    const totalCost = standby.reduce((s, r) => s + r.estimated_annual_cost, 0);
    tips.push(
      `Branchez vos appareils en veille sur des multiprises avec interrupteur. ` +
      `Les ${standby.length} appareil(s) detecte(s) en veille representent un cout annuel estime de ${totalCost.toFixed(2)} EUR.`
    );
  }

  // Top consommateurs
  if (topConsumers.length > 0) {
    const top = topConsumers[0];
    tips.push(
      `L'appareil "${top.appliance_name}" est votre plus gros consommateur ` +
      `(${top.total_kwh} kWh, ${top.percentage}%). Verifiez son efficacite energetique.`
    );
  }

  // Confort thermique
  const badRooms = comfort.filter(c => c.status === 'bad');
  if (badRooms.length > 0) {
    tips.push(
      `Les pieces ${badRooms.map(r => `"${r.room_name}"`).join(', ')} sont frequemment hors zone de confort. ` +
      `Verifiez l'isolation et le chauffage.`
    );
  }

  const coldRooms = comfort.filter(c => c.avg_temp !== null && c.avg_temp < 19);
  if (coldRooms.length > 0) {
    tips.push(
      `La temperature moyenne dans ${coldRooms.map(r => `"${r.room_name}"`).join(', ')} est inferieure a 19 degC. ` +
      `Envisagez d'ameliorer l'isolation.`
    );
  }

  const humidRooms = comfort.filter(c => c.avg_humidity !== null && c.avg_humidity > 60);
  if (humidRooms.length > 0) {
    tips.push(
      `L'humidite dans ${humidRooms.map(r => `"${r.room_name}"`).join(', ')} est elevee. ` +
      `Aerez regulierement ou utilisez un deshumidificateur.`
    );
  }

  // Qualite d'air
  const stuffyRooms = (airQuality?.rooms || []).filter(r => r.status !== 'good');
  if (stuffyRooms.length > 0) {
    tips.push(
      `Le CO2 depasse souvent ${CO2_GOOD} ppm dans ${stuffyRooms.map(r => `"${r.room_name}"`).join(', ')}. ` +
      `Aerez 5 a 10 minutes plusieurs fois par jour et verifiez les grilles de ventilation.`
    );
  }

  // Consommation generale
  if (energy.daily_avg_kwh > 15) {
    tips.push(
      `Votre consommation quotidienne moyenne (${energy.daily_avg_kwh} kWh/jour) est elevee. ` +
      `Identifiez les usages superflus.`
    );
  }

  // Conseils generaux
  tips.push(
    'Privilegiez les appareils avec une etiquette energetique A ou superieure lors du remplacement.'
  );
  tips.push(
    'Utilisez des programmateurs pour eteindre automatiquement les appareils la nuit.'
  );

  return tips;
}

module.exports = { generateReport };
