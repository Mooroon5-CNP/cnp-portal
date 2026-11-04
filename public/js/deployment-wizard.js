/* eslint-env browser */
(function() {
  'use strict';
  const form = document.getElementById('newDeploymentForm');
  if (!form) return;
  const panels = Array.from(form.querySelectorAll('[data-deployment-step]')); const error = form.querySelector('[data-wizard-error]');
  const back = form.querySelector('[data-wizard-back]'); const next = form.querySelector('[data-wizard-next]'); const submit = form.querySelector('[type="submit"]');
  const storageStatus = form.querySelector('[data-wizard-storage-status]');
  const label = form.querySelector('[data-wizard-progress]'); let step = 1; let submitting = false; let variables;
  function showError(message) { error.textContent = message; error.hidden = !message; }
  function refresh() {
    step = Math.max(1, Math.min(panels.length, step));
    panels.forEach(panel => { panel.hidden = Number(panel.dataset.deploymentStep) !== step; });
    label.textContent = `${step}/3 — ${['Application', 'Variables', 'Récapitulatif'][step - 1]}`;
    back.hidden = step === 1; next.hidden = step === 3; submit.hidden = step !== 3;
    submit.disabled = submitting || step !== 3 || (variables && !variables.ready());
    next.disabled = submitting || step >= panels.length; back.disabled = submitting;
    if (storageStatus) {
      const blocked = step === 3 && variables && !variables.ready();
      storageStatus.hidden = !blocked;
      storageStatus.textContent = blocked ? 'Récapitulatif disponible. Le déploiement avec ces variables attend la vérification du stockage sécurisé. Revenez à Variables pour consulter le diagnostic et réessayer. Aucune valeur n’a été envoyée.' : '';
    }
    for (const id of ['closeNewDeployment', 'cancelNewDeployment']) { const button = document.getElementById(id); if (button) button.disabled = submitting; }
  }
  function validateApplication() {
    if (!['gcp', 'azure'].includes(form.elements.targetCluster.value)) throw new Error('Ce cloud n’est pas disponible.');
    for (const input of panels[0].querySelectorAll('input,select')) if (!input.checkValidity()) { input.reportValidity(); return false; }
    return true;
  }
  function validateVariables(requireStorage = false) {
    variables.validate();
    if (variables.entries().length && form.elements.targetCluster.value !== 'gcp') throw new Error('Les variables additionnelles sont disponibles pour Cloud Run GCP.');
    if (requireStorage && !variables.ready()) throw new Error('Le stockage sécurisé doit être configuré par un administrateur avant de déployer avec des variables.');
    return true;
  }
  function renderSummary() {
    const target = form.querySelector('[data-deployment-summary]'); target.replaceChildren();
    const lines = [`Application : ${form.elements.appName.value}`, `Dépôt : ${form.elements.githubRepoUrl.value}`,
      `Environnement : ${form.elements.environment.value}`, `Cloud : ${form.elements.targetCluster.value}`, `Port : ${form.elements.appPort.value}`,
      ...variables.summary()];
    if (!variables.entries().length) lines.push('Aucune variable additionnelle.');
    for (const line of lines) { const paragraph = document.createElement('p'); paragraph.textContent = line; target.appendChild(paragraph); }
    variables.mask();
  }
  variables = window.CNPVariables.editor(form.querySelector('[data-variables-editor]'), refresh);
  variables.setEnabled(form.elements.targetCluster.value === 'gcp');
  next.addEventListener('click', () => {
    if (submitting || step >= panels.length) return;
    showError('');
    try { if (step === 1 && !validateApplication()) return; if (step === 2) { validateVariables(); renderSummary(); } step = Math.min(panels.length, step + 1); refresh(); }
    catch (failure) { showError(failure.message); }
  });
  back.addEventListener('click', () => { if (submitting) return; step = Math.max(1, step - 1); showError(''); refresh(); });
  form.elements.targetCluster.addEventListener('change', () => variables.setEnabled(form.elements.targetCluster.value === 'gcp'));
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (submitting) return;
    if (step !== 3) { next.click(); return; }
    try {
      if (!validateApplication()) { step = 1; refresh(); return; } validateVariables(true);
      if (variables.entries().length && location.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) throw new Error('Utilisez HTTPS pour transmettre des secrets.');
      submitting = true; showError(''); refresh(); submit.textContent = 'Préparation…';
      const response = await fetch(form.action, { method: 'POST', headers: { Accept: 'application/json' }, body: new URLSearchParams(new FormData(form)) });
      const result = await response.json();
      if (!response.ok || !result.redirect) throw new Error(result.error || 'Déploiement non enregistré.');
      variables.clear(); window.location.assign(result.redirect);
    } catch (failure) { showError(failure.message || 'La demande a échoué. Les champs restent disponibles pour réessayer.'); }
    finally { submitting = false; submit.textContent = 'Déployer'; refresh(); }
  });
  document.getElementById('newDeploymentModal').addEventListener('cnp:closed', () => { variables.clear(); form.reset(); if (form.elements.appName.dataset) delete form.elements.appName.dataset.userEdited; step = 1; showError(''); variables.setEnabled(true); refresh(); });
  window.addEventListener('pagehide', () => { variables.clear(); form.reset(); step = 1; showError(''); refresh(); });
  refresh();
})();
