/* global document, window */
'use strict';

// Prefill the existing form only. Submission still uses the unchanged deployment route.
(() => {
    const values = new URLSearchParams(window.location.hash.slice(1));
    const repository = values.get('repository');
    if (!repository || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[a-z0-9-]+$/.test(repository)) return;
    const input = document.getElementById('githubRepoUrl');
    const button = document.getElementById('openNewDeployment');
    if (!input || !button) return;
    input.value = repository;
    document.getElementById('appName').value = repository.split('/').pop();
    const port = Number(values.get('port'));
    if (Number.isInteger(port) && port > 0 && port <= 65535) document.getElementById('appPort').value = port;
    button.click();
})();
