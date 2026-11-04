/* eslint-env browser */
(function() {
  'use strict';
  const form = document.getElementById('applicationVariablesForm'); if (!form) return;
  const submit = form.querySelector('[type="submit"]'); const error = form.querySelector('[data-variables-error]');
  let saving = false; let editor;
  function refresh() { submit.disabled = saving || !editor || !editor.ready() || !editor.hasChanges(); }
  editor = window.CNPVariables.editor(form.querySelector('[data-variables-editor]'), refresh); refresh();
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (saving) return;
    error.hidden = true;
    try {
      editor.validate();
      if (!editor.ready() || !editor.hasChanges()) throw new Error('Vérifiez les variables et la disponibilité du stockage.');
      if (location.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) throw new Error('Utilisez HTTPS pour transmettre des secrets.');
      saving = true; refresh();
      const response = await fetch(form.action, { method: 'POST', headers: { Accept: 'application/json' }, body: new URLSearchParams(new FormData(form)) });
      const result = await response.json();
      if (!response.ok || !result.redirect) throw new Error(result.error || 'Modifications non enregistrées.');
      editor.clear(); window.location.assign(result.redirect);
    } catch (failure) { error.textContent = failure.message || 'La demande a échoué. Vous pouvez réessayer.'; error.hidden = false; }
    finally { saving = false; refresh(); }
  });
  window.addEventListener('pagehide', () => editor.clear());
})();
