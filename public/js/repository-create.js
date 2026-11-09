/* global document */
'use strict';

const concurrency = document.getElementById('concurrency');
const availability = document.getElementById('availability');
function recommend() {
    const message = document.getElementById('recommendation');
    if (!concurrency.value || !availability.value) {
        message.textContent = 'Répondez aux deux questions pour obtenir une recommandation.';
        return;
    }
    message.textContent = concurrency.value === 'yes' || availability.value === 'yes'
        ? 'Nous recommandons PostgreSQL pour vos besoins de concurrence ou de secours. Confirmez ce choix dans la liste des modèles.'
        : 'SQLite convient à ce besoin simple. PostgreSQL reste possible si vos besoins évoluent. Confirmez votre choix dans la liste des modèles.';
}
concurrency.addEventListener('change', recommend);
availability.addEventListener('change', recommend);
const form = document.querySelector('form[action="/repositories"]');
const error = document.getElementById('repositoryError');
function showError(message) {
    error.textContent = message;
    error.hidden = false;
    error.focus();
}
if (!error.hidden) error.focus();
form.addEventListener('submit', event => {
    const invalid = form.querySelector(':invalid');
    if (invalid) {
        event.preventDefault();
        const messages = {
            name: 'Nom invalide : 2 à 39 caractères, minuscules, chiffres et tirets, sans tiret au début ni à la fin.',
            template: 'Choisissez un modèle SQLite ou PostgreSQL.',
            port: 'Le port applicatif doit être compris entre 1 et 65535.',
            description: 'Description trop longue (350 caractères maximum).',
            publicAcknowledged: 'Confirmez que le repo sera public.',
        };
        showError(messages[invalid.name] || 'Vérifiez les informations saisies.');
        return;
    }
    const button = event.target.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = 'Création en cours…';
});
