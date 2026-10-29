/**
 * beaba — api/auth.js
 * Authentification par magic link.
 */

'use strict';
const { Router } = require('express');
const crypto = require('crypto');
const { getDb } = require('../db');
const { sign } = require('../lib/jwt');
const { sendMagicLink } = require('../lib/email');
const { requireAuth } = require('./middleware');

const router = Router();

// POST /login — envoyer un magic link
router.post('/login', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requis' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
  if (!user) return res.status(404).json({ error: 'Email non reconnu' });

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  db.prepare('INSERT INTO auth_tokens (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, expiresAt);

  // Le lien pointe vers l'API (backend), pas le frontend
  const apiBase = process.env.API_PUBLIC_URL || `${req.protocol}://${req.get('host')}/api`;
  try {
    await sendMagicLink(email, token, apiBase);
  } catch (err) {
    console.error('[Auth] Erreur envoi email :', err.message);
    return res.status(500).json({ error: 'Erreur envoi email' });
  }

  res.json({ ok: true, message: 'Lien envoye' });
});

// Consomme un token de magic link et pose le cookie de session.
// Renvoie false si le token est inconnu, deja utilise ou perime.
function consumeToken(token, res) {
  if (!token) return false;

  const db = getDb();
  const row = db.prepare(`
    SELECT at.*, u.email, u.name, u.role
    FROM auth_tokens at
    JOIN users u ON u.id = at.user_id
    WHERE at.token = ? AND at.used = 0 AND at.expires_at > datetime('now') AND u.active = 1
  `).get(token);

  if (!row) return false;

  db.prepare('UPDATE auth_tokens SET used = 1 WHERE token = ?').run(token);

  const jwt = sign({ id: row.user_id, email: row.email, name: row.name, role: row.role });

  // Cookie cross-domain si COOKIE_DOMAIN defini (ex: .450ppm.be)
  const cookieOpts = {
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  };
  if (process.env.COOKIE_DOMAIN) {
    cookieOpts.domain = process.env.COOKIE_DOMAIN;
    cookieOpts.sameSite = 'none';
    cookieOpts.secure = true;
  } else {
    cookieOpts.sameSite = 'lax';
  }
  res.cookie('beaba_token', jwt, cookieOpts);
  return true;
}

// GET /verify — lien recu par email.
// Avec un front separe (FRONTEND_URL), on ne consomme PAS le token ici : les
// antivirus de messagerie (Safe Links...) ouvrent le lien avant le conseiller
// et le grillaient. Le front le consomme via POST /verify apres un clic.
router.get('/verify', (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL || '';
  const { token } = req.query;
  if (!token) return res.redirect(`${frontendUrl}/login?error=expired`);

  if (frontendUrl) {
    return res.redirect(`${frontendUrl}/login/verify?token=${encodeURIComponent(token)}`);
  }

  if (!consumeToken(token, res)) return res.redirect('/login?error=expired');
  res.redirect('/app');
});

// POST /verify — consommer le token depuis le front
router.post('/verify', (req, res) => {
  if (!consumeToken(req.body?.token, res)) {
    return res.status(401).json({ error: 'Ce lien de connexion a expiré ou a déjà été utilisé.' });
  }
  res.json({ ok: true });
});

// POST /logout — supprimer le cookie
router.post('/logout', (req, res) => {
  const opts = { path: '/' };
  if (process.env.COOKIE_DOMAIN) {
    opts.domain = process.env.COOKIE_DOMAIN;
    opts.sameSite = 'none';
    opts.secure = true;
  }
  res.clearCookie('beaba_token', opts);
  res.json({ ok: true });
});

// GET /me — utilisateur connecte
router.get('/me', requireAuth, (req, res) => {
  res.json(req.user);
});

module.exports = router;
