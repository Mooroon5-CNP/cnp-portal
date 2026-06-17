'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requirePermission, requireRole, can } = require('../middleware/rbac');
const teamService = require('../services/teams');
const userStore = require('../models/user');

router.get('/', requireAuth, requirePermission('teams:view'), (req, res) => {
  const allTeams = teamService.listTeams();
  const allUsers = userStore.findAll().filter(u => u.active);

  const visibleTeams = req.user.role === 'manager'
    ? allTeams
    : allTeams.filter(t => t.memberIds.includes(req.user.id));

  res.render('admin/teams', {
    title: 'Équipes — CNP Portal',
    currentPage: 'admin',
    teams: visibleTeams,
    allUsers,
    user: req.user,
    can: (p) => can(req.user, p),
  });
});

const TEAM_NAME_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

router.post('/', requireAuth, requireRole('manager'), (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) {
    req.flash('error', 'Le nom de l\'équipe est requis.');
    return res.redirect('/admin/teams');
  }
  if (!TEAM_NAME_RE.test(name)) {
    req.flash('error', 'Le nom doit contenir uniquement des minuscules, chiffres et tirets (sans tiret en début ou fin).');
    return res.redirect('/admin/teams');
  }
  teamService.createTeam(name);
  req.flash('success', `Équipe "${name}" créée.`);
  res.redirect('/admin/teams');
});

router.post('/:id/members', requireAuth, requirePermission('teams:view'), (req, res) => {
  const team = teamService.getTeam(req.params.id);
  if (!team) {
    req.flash('error', 'Équipe introuvable.');
    return res.redirect('/admin/teams');
  }

  const target = userStore.findById(req.body.userId);
  if (!target) {
    req.flash('error', 'Utilisateur introuvable.');
    return res.redirect('/admin/teams');
  }

  if (req.user.role === 'devops') {
    if (target.role !== 'dev') {
      req.flash('error', 'Les devops ne peuvent ajouter que des devs.');
      return res.redirect('/admin/teams');
    }
    if (!teamService.isMemberOf(req.params.id, req.user.id)) {
      req.flash('error', 'Vous ne pouvez gérer que vos propres équipes.');
      return res.redirect('/admin/teams');
    }
  }

  teamService.addMember(req.params.id, target.id);
  req.flash('success', `${target.username} ajouté à l'équipe "${team.name}".`);
  res.redirect('/admin/teams');
});

router.post('/:id/members/:userId/remove', requireAuth, requirePermission('teams:view'), (req, res) => {
  const team = teamService.getTeam(req.params.id);
  if (!team) {
    req.flash('error', 'Équipe introuvable.');
    return res.redirect('/admin/teams');
  }

  const target = userStore.findById(req.params.userId);
  if (!target) {
    req.flash('error', 'Utilisateur introuvable.');
    return res.redirect('/admin/teams');
  }

  if (req.user.role === 'devops') {
    if (target.role !== 'dev') {
      req.flash('error', 'Les devops ne peuvent retirer que des devs.');
      return res.redirect('/admin/teams');
    }
    if (!teamService.isMemberOf(req.params.id, req.user.id)) {
      req.flash('error', 'Vous ne pouvez gérer que vos propres équipes.');
      return res.redirect('/admin/teams');
    }
  }

  teamService.removeMember(req.params.id, target.id);
  req.flash('success', `${target.username} retiré de l'équipe "${team.name}".`);
  res.redirect('/admin/teams');
});

router.post('/:id/delete', requireAuth, requireRole('manager'), (req, res) => {
  const team = teamService.getTeam(req.params.id);
  if (!team) {
    req.flash('error', 'Équipe introuvable.');
    return res.redirect('/admin/teams');
  }
  teamService.deleteTeam(req.params.id);
  req.flash('success', `Équipe "${team.name}" supprimée.`);
  res.redirect('/admin/teams');
});

module.exports = router;
