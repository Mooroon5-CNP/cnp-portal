'use strict';

// Création d'un nouveau dépôt applicatif à partir des squelettes CNP.
//
// Les squelettes vivent dans Mooroon5-CNP/ci-templates (dossier skeletons/) :
//   skeletons/_common/    fichiers communs à tous les langages (README.md…)
//   skeletons/<langage>/  squelette du langage ; il l'emporte sur _common/
// Le portail crée le dépôt, y pousse le squelette en UN commit, crée la branche
// prod, puis rend la main : l'onboarding existant (ci.yml, secrets, premier CI)
// s'exécute ensuite exactement comme pour un dépôt existant.

const githubClient = require('../clients/github');
const { config } = require('../config/env');

const LANGUAGES = {
    node: 'Node.js',
    python: 'Python',
    go: 'Go',
    java: 'Java (Maven)',
    cpp: 'C++ (CMake)',
    fullstack: 'Fullstack — web (Node) + api (Python)',
};

// Branches créées dans tout nouveau dépôt : main -> dev, prod -> production.
const DEFAULT_BRANCHES = ['main', 'prod'];

// Dépôts de la plateforme qu'une application ne doit jamais pouvoir usurper.
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

function skeletonsSource() {
    return { owner: organisation(), repo: 'ci-templates', ref: process.env.CNP_SKELETONS_REF || 'main' };
}

function validate({ name, language, port }) {
    if (!Object.prototype.hasOwnProperty.call(LANGUAGES, language)) {
        throw new ScaffoldError('Langage inconnu : choisissez un des langages proposés.');
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

// Fichiers du squelette : _common/ puis <langage>/ (le langage l'emporte).
async function loadSkeleton(language, values) {
    const { owner, repo, ref } = skeletonsSource();
    const blobs = await githubClient.listBlobs(owner, repo, ref);
    const byPath = new Map();
    for (const prefix of [`skeletons/_common/`, `skeletons/${language}/`]) {
        for (const blob of blobs.filter(b => b.path.startsWith(prefix))) {
            byPath.set(blob.path.slice(prefix.length), blob.sha);
        }
    }
    if (![...byPath.keys()].some(p => p !== 'README.md')) {
        throw new ScaffoldError(`Aucun squelette « ${language} » trouvé dans ${owner}/${repo}@${ref}.`);
    }
    const files = [];
    for (const [path, sha] of byPath) {
        files.push({ path, content: render(await githubClient.getBlob(owner, repo, sha), values) });
    }
    return files;
}

// Un dépôt tout juste créé peut répondre 404 quelques secondes.
async function waitForBranch(owner, repo, branch, sleep) {
    let lastError;
    for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
        try { return await githubClient.getRef(owner, repo, branch); }
        catch (err) { lastError = err; await sleep(READY_DELAY_MS); }
    }
    throw new Error(`Le dépôt ${owner}/${repo} n'est pas prêt : ${lastError && lastError.message}`);
}

/**
 * Crée le dépôt public <org>/<name> avec le squelette du langage, puis les branches main et prod.
 * Ne touche jamais à un dépôt existant : un nom déjà pris est refusé.
 * @returns {{ owner: string, repo: string, url: string, branches: string[] }}
 */
async function scaffoldRepository({ name, language, port, description }, { sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
    validate({ name, language, port });
    const owner = organisation();

    if (await githubClient.getRepoOrNull(owner, name)) {
        throw new ScaffoldError(`Le dépôt ${owner}/${name} existe déjà. Choisissez un autre nom, ou utilisez « Dépôt GitHub existant ».`);
    }

    // Lecture du squelette AVANT toute création : un squelette illisible ne laisse pas de dépôt vide.
    const files = await loadSkeleton(language, { name, port });

    const url = `https://github.com/${owner}/${name}`;
    // Échec ici = rien n'a été créé par cette requête (ex. nom pris à l'instant par quelqu'un d'autre).
    try {
        await githubClient.createOrgRepo(owner, name, { description: description || `Application ${name} (squelette CNP ${language})`, isPrivate: false });
    } catch (err) {
        throw new ScaffoldError(`Impossible de créer le dépôt ${owner}/${name} : ${err.message}`);
    }
    try {
        await waitForBranch(owner, name, 'main', sleep);
        const headSha = await githubClient.commitFiles(owner, name, 'main', files, COMMIT_MESSAGE);
        for (const branch of DEFAULT_BRANCHES.filter(b => b !== 'main')) {
            await githubClient.createBranch(owner, name, branch, headSha);
        }
    } catch (err) {
        throw new ScaffoldError(`Création incomplète du dépôt ${url} : ${err.message}. Le dépôt n'est pas supprimé : corrigez-le puis utilisez « Dépôt GitHub existant ».`);
    }
    return { owner, repo: name, url, branches: [...DEFAULT_BRANCHES] };
}

module.exports = { scaffoldRepository, validate, render, LANGUAGES, DEFAULT_BRANCHES, RESERVED_NAMES, ScaffoldError };
