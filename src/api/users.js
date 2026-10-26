/**
 * beaba — api/users.js
 * CRUD utilisateurs (admin seulement).
 */

'use strict';
const { Router } = require('express');
const crypto = require('crypto');
const { getDb } = require('../db');

const router = Router();

// GET / — lister tous les utilisateurs
router.get('/', (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT id, email, name, role, can_pair, created_at, active FROM users ORDER BY created_at').all();
  res.json(users);
});

// POST / — creer un utilisateur
router.post('/', (req, res) => {
  const { email, name, role } = req.body;
  if (!email || !name) return res.status(400).json({ error: 'email et name requis' });

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'Email deja utilise' });

  const id = crypto.randomUUID();
  db.prepare('INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, ?)').run(id, email, name, role || 'advisor');

  res.status(201).json({ id, email, name, role: role || 'advisor' });
});

// PUT /:id — modifier un utilisateur
router.put('/:id', (req, res) => {
  const { name, email, active, can_pair } = req.body;
  const db = getDb();

  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

  db.prepare(`
    UPDATE users SET
      name     = COALESCE(?, name),
      email    = COALESCE(?, email),
      active   = COALESCE(?, active),
      can_pair = COALESCE(?, can_pair)
    WHERE id = ?
  `).run(
    name, email,
    active != null ? (active ? 1 : 0) : null,
    can_pair != null ? (can_pair ? 1 : 0) : null,
    req.params.id
  );

  res.json({ ok: true });
});

// DELETE /:id — desactiver un utilisateur (soft delete)
router.delete('/:id', (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
