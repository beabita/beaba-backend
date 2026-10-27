/**
 * beaba — purge.js
 * Effacement complet d'une campagne du Raspberry Pi (RGPD : une campagne
 * terminee et archivee ne doit pas rester sur le kit).
 *
 * Execution directe (admin, sur le Pi) :
 *   node src/db/purge.js <campaignId>          → apercu, rien n'est efface
 *   node src/db/purge.js <campaignId> --yes    → efface
 */

'use strict';
require('dotenv').config();
const Database = require('better-sqlite3');

// Prise/capteur → table de releves. Les ids sont ceux du kit (prise01,
// adresse IEEE...) et INSERT OR REPLACE les fait passer d'une campagne a
// l'autre : des releves d'une campagne precedente peuvent encore pointer
// vers une ligne de celle-ci. Ils sont effaces aussi.
const DEVICES = [
  ['plugs',        'readings_power',     'plug_id',   true],
  ['temp_sensors', 'readings_temp',      'sensor_id', true],
  ['co2_sensors',  'readings_co2',       'sensor_id', true],
  ['pipe_sensors', 'readings_pipe_temp', 'sensor_id', false],
];

/**
 * Efface la campagne, ses pieces, prises, capteurs, releves compteurs et
 * tous les releves lies a ses appareils. Retourne le nombre de lignes
 * effacees par table.
 */
function purgeCampaign(db, campaignId) {
  const counts = {};
  const del = (table, sql, ...args) => {
    counts[table] = (counts[table] || 0) + db.prepare(sql).run(...args).changes;
  };

  db.transaction(() => {
    for (const [table, readings, col, hasRoom] of DEVICES) {
      del(readings, `DELETE FROM ${readings} WHERE campaign_id = ?`, campaignId);
      del(readings, `DELETE FROM ${readings} WHERE ${col} IN (SELECT id FROM ${table} WHERE campaign_id = ?)`, campaignId);
      if (hasRoom) {
        db.prepare(`UPDATE ${table} SET room_id = NULL WHERE room_id IN (SELECT id FROM rooms WHERE campaign_id = ?)`).run(campaignId);
      }
    }
    del('plug_appliances', 'DELETE FROM plug_appliances WHERE plug_id IN (SELECT id FROM plugs WHERE campaign_id = ?)', campaignId);
    for (const [table] of DEVICES) {
      del(table, `DELETE FROM ${table} WHERE campaign_id = ?`, campaignId);
    }
    del('meter_readings', 'DELETE FROM meter_readings WHERE campaign_id = ?', campaignId);
    del('rooms', 'DELETE FROM rooms WHERE campaign_id = ?', campaignId);
    del('campaigns', 'DELETE FROM campaigns WHERE id = ?', campaignId);
  })();

  return counts;
}

if (require.main === module) {
  const [campaignId, flag] = process.argv.slice(2);
  const db = new Database(process.env.SQLITE_PATH || './data/beaba.db');
  db.pragma('foreign_keys = ON');

  const campaign = campaignId && db.prepare('SELECT id, household, status, created_at FROM campaigns WHERE id = ?').get(campaignId);
  if (!campaign) {
    console.log('Usage : node src/db/purge.js <campaignId> [--yes]\nCampagnes :');
    console.table(db.prepare('SELECT id, household, status, created_at, archived_at FROM campaigns ORDER BY created_at').all());
    process.exit(campaignId ? 1 : 0);
  }

  console.log(`Campagne ${campaign.household} (${campaign.status}, creee le ${campaign.created_at})`);
  if (flag !== '--yes') {
    // Meme effacement dans une transaction annulee (better-sqlite3 fait de
    // la transaction interne un savepoint).
    db.exec('BEGIN');
    console.log('Apercu — serait efface :', purgeCampaign(db, campaignId));
    db.exec('ROLLBACK');
    console.log('Relancer avec --yes pour effacer.');
  } else {
    console.log('Efface :', purgeCampaign(db, campaignId));
  }
  db.close();
}

module.exports = { purgeCampaign };
