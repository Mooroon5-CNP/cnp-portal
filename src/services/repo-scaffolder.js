'use strict';

// Standalone repository creation: never invokes deployment or onboarding.
const githubClient = require('../clients/github');
const { config } = require('../config/env');

const fs = require('fs/promises');
const path = require('path');
const TEMPLATES = {
    sqlite: { label: 'Python · SQLite', description: 'Base dans un fichier, pour un usage simple avec peu d’écritures simultanées.' },
    postgres: { label: 'Python · PostgreSQL', description: 'Serveur de base de données séparé, pour des écritures concurrentes et les options de secours PostgreSQL.' },
};

// Branches créées dans tout nouveau repo : main -> dev, prod -> production.
const DEFAULT_BRANCHES = ['main', 'prod'];

// Repos de la plateforme qu'une application ne doit jamais pouvoir usurper.
const RESERVED_NAMES = new Set([
    'config-repo', 'ci-templates', 'cnp-portal', 'mcp-cnp', '.github', 'github',
]);

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,37}[a-z0-9]$/;
const COMMIT_MESSAGE = 'chore: initial skeleton from the CNP templates';
const READY_ATTEMPTS = 6;
const READY_DELAY_MS = 1500;

class ScaffoldError extends Error {}

function organisation() {
    return (config.github.configRepoName || 'Mooroon5-CNP/config-repo').split('/')[0];
}

function validate({ name, template, port }) {
    if (!Object.prototype.hasOwnProperty.call(TEMPLATES, template)) {
        throw new ScaffoldError('Modèle inconnu : choisissez SQLite ou PostgreSQL.');
    }
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
        throw new ScaffoldError('Nom invalide : 2 à 39 caractères, minuscules, chiffres et tirets, sans tiret au début ni à la fin.');
    }
    if (RESERVED_NAMES.has(name)) {
        throw new ScaffoldError(`Le nom « ${name} » est réservé à la plateforme.`);
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new ScaffoldError('Le port applicatif doit être compris entre 1 et 65535.');
    }
}

// Remplace uniquement les deux jetons documentés ; name et port sont déjà validés.
function render(content, { name, port }) {
    return Buffer.from(content.toString('utf8')
        .split('{{APP_NAME}}').join(name)
        .split('{{APP_PORT}}').join(String(port)), 'utf8');
}

// Read bundled, reviewed database templates before creating anything on GitHub.
async function loadSkeleton(template, values) {
    const root = path.join(__dirname, '../templates/repositories');
    const files = new Map();
    for (const folder of ['common', template]) {
        for (const name of await fs.readdir(path.join(root, folder))) {
            files.set(name, { path: name, content: render(await fs.readFile(path.join(root, folder, name)), values) });
        }
    }
    return [...files.values()];
}

// Un repo tout juste créé peut répondre 404 quelques secondes.
async function waitForBranch(owner, repo, branch, sleep) {
    let lastError;
    for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
        try { return await githubClient.getRef(owner, repo, branch); }
        catch (err) { lastError = err; await sleep(READY_DELAY_MS); }
    }
    throw new Error(`Le repo ${owner}/${repo} n'est pas prêt : ${lastError && lastError.message}`);
}

/**
 * Crée le repo public <org>/<name> avec le modèle choisi, puis les branches main et prod.
 * Ne touche jamais à un repo existant : un nom déjà pris est refusé.
 * @returns {{ owner: string, repo: string, url: string, branches: string[] }}
 */
async function scaffoldRepository({ name, template, port, description }, { sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
    validate({ name, template, port });
    if (description && (typeof description !== 'string' || description.length > 350)) throw new ScaffoldError('Description trop longue (350 caractères maximum).');
    const owner = organisation();

    if (await githubClient.getRepoOrNull(owner, name)) {
        throw new ScaffoldError(`Le repo ${owner}/${name} existe déjà. Choisissez un autre nom, ou utilisez « Repo GitHub existant ».`);
    }

    // Lecture du squelette AVANT toute création : un squelette illisible ne laisse pas de repo vide.
    const files = await loadSkeleton(template, { name, port });

    const url = `https://github.com/${owner}/${name}`;
    // Échec ici = rien n'a été créé par cette requête (ex. nom pris à l'instant par quelqu'un d'autre).
    let created;
    try {
        created = await githubClient.createOrgRepo(owner, name, { description: description || `Application ${name} (squelette CNP ${template})`, isPrivate: false });
    } catch (err) {
        throw new ScaffoldError(`Impossible de créer le repo ${owner}/${name} : ${err.message}`);
    }
    try {
        const initialBranch = created.default_branch || 'main';
        const initialSha = await waitForBranch(owner, name, initialBranch, sleep);
        if (initialBranch !== 'main') await githubClient.createBranch(owner, name, 'main', initialSha);
        const headSha = await githubClient.commitFiles(owner, name, 'main', files, COMMIT_MESSAGE);
        if (initialBranch !== 'main') await githubClient.setDefaultBranch(owner, name, 'main');
        for (const branch of DEFAULT_BRANCHES.filter(b => b !== 'main')) {
            await githubClient.createBranch(owner, name, branch, headSha);
        }
    } catch (err) {
        throw new ScaffoldError(`Création incomplète du repo ${url} : ${err.message}. Le repo n'est pas supprimé : corrigez-le puis utilisez « Repo GitHub existant ».`);
    }
    return { owner, repo: name, url, branches: [...DEFAULT_BRANCHES], template, port };
}

module.exports = { scaffoldRepository, validate, render, TEMPLATES, DEFAULT_BRANCHES, RESERVED_NAMES, ScaffoldError };
