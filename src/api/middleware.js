/**
 * beaba — api/middleware.js
 * Middlewares Express : auth, admin, campagne active.
 */

'use strict';
const { getDb, getActiveCampaign } = require('../db');
const { verify } = require('../lib/jwt');

/**
 * requireAuth — verifie le JWT dans le cookie beaba_token.
 * Injecte req.user = {id, email, name, role, can_pair}.
 */
function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.beaba_token;
  if (!token) return res.status(401).json({ error: 'Non authentifie' });

  const payload = verify(token);
  if (!payload) return res.status(401).json({ error: 'Token invalide' });

  const db = getDb();
  const user = db.prepare('SELECT id, email, name, role, can_pair FROM users WHERE id = ? AND active = 1').get(payload.id);
  if (!user) return res.status(401).json({ error: 'Utilisateur introuvable ou desactive' });

  req.user = { ...user, can_pair: user.role === 'admin' || !!user.can_pair };
  next();
}

/**
 * requireAdmin — verifie que l'utilisateur est admin.
 * Doit etre place apres requireAuth.
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acces reserve aux administrateurs' });
  }
  next();
}

/**
 * requirePairing — appairage Zigbee : admins et conseillers autorises.
 * Doit etre place apres requireAuth.
 */
function requirePairing(req, res, next) {
  if (!req.user || !req.user.can_pair) {
    return res.status(403).json({ error: "Appairage reserve aux installateurs Zigbee. Demandez l'acces a un administrateur." });
  }
  next();
}

/**
 * requireActiveCampaign — injecte req.campaign.
 * Filtre par user_id sauf pour les admins.
 */
function requireActiveCampaign(req, res, next) {
  const userId = req.user && req.user.role !== 'admin' ? req.user.id : null;
  const campaign = getActiveCampaign(userId);
  if (!campaign) return res.status(409).json({ error: 'Aucune campagne active' });
  req.campaign = campaign;
  next();
}

module.exports = { requireAuth, requireAdmin, requirePairing, requireActiveCampaign };
