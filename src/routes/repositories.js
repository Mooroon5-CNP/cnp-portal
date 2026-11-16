'use strict';

const router = require('express').Router();
const { randomUUID } = require('crypto');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const scaffolder = require('../services/repo-scaffolder');

router.use(requireAuth, requirePermission('repositories:create'));

function showForm(req, res, status = 200, error = null) {
    req.session.repositoryCreationToken = randomUUID();
    return res.status(status).render('repositories/create', {
        title: 'Créer un repo', currentPage: 'repositories',
        templates: scaffolder.TEMPLATES, values: req.body || {}, error,
        submissionToken: req.session.repositoryCreationToken,
    });
}

router.get('/new', (req, res) => showForm(req, res));

router.post('/', async (req, res) => {
    // Consume before the first await to prevent double submissions in this session.
    if (!req.session.repositoryCreationToken || req.body.submissionToken !== req.session.repositoryCreationToken) {
        return showForm(req, res, 409, 'Cette demande a déjà été envoyée ou a expiré. Vérifiez vos repos avant de réessayer.');
    }
    delete req.session.repositoryCreationToken;
    if (req.body.publicAcknowledged !== 'yes') {
        return showForm(req, res, 400, 'Confirmez que le repo sera public.');
    }
    try {
        const repository = await scaffolder.scaffoldRepository({
            name: req.body.name, template: req.body.template,
            port: Number(req.body.port), description: req.body.description,
        });
        req.session.createdRepository = repository;
        return res.redirect(303, '/repositories/created');
    } catch (error) {
        return showForm(req, res, error instanceof scaffolder.ScaffoldError ? 400 : 502, error.message);
    }
});

router.get('/created', (req, res) => {
    const repository = req.session.createdRepository;
    if (!repository) return res.redirect('/repositories/new');
    res.render('repositories/created', {
        title: 'Repo créé', currentPage: 'repositories', repository,
        template: scaffolder.TEMPLATES[repository.template],
    });
});

module.exports = router;
