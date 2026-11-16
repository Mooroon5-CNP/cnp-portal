(function (root) {
  'use strict';

  const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const RESERVED = /^(?:PORT|APP_PORT|DB_|DD_|CNP_)/i;

  function parseDotEnv(input) {
    if (typeof input !== 'string' || input.length > 65536) throw new Error('Fichier .env trop volumineux (64 Ko maximum).');
    const rows = [];
    const seen = new Set();
    const lines = input.replace(/^\uFEFF/, '').split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].trim();
      if (!line || line.startsWith('#')) continue;
      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) throw new Error(`Ligne .env ${index + 1} invalide.`);
      const name = match[1];
      if (RESERVED.test(name) || seen.has(name)) throw new Error(`Variable .env ${name} réservée ou en doublon.`);
      seen.add(name);
      let value = match[2];
      if (value.startsWith('"') || value.startsWith("'")) {
        const quote = value[0];
        if (value.length < 2 || value.at(-1) !== quote) throw new Error(`Guillemets .env non fermés ligne ${index + 1}.`);
        value = value.slice(1, -1);
        if (quote === '"') value = value.replace(/\\([nrt"\\])/g, (_all, escaped) =>
          ({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' })[escaped]);
      } else {
        value = value.replace(/\s+#.*$/, '').trim();
      }
      if (/\$(?:\{|[A-Za-z_(])|`/.test(value)) throw new Error(`Substitution .env interdite ligne ${index + 1}.`);
      rows.push({ name, value });
    }
    if (rows.length > 50) throw new Error('Trop de variables (maximum 50).');
    return rows;
  }

  function init(options = {}) {
    const document = root.document;
    const ids = { form: 'newDeploymentForm', list: 'deploymentVariableRows', file: 'deploymentEnvFile',
      summary: 'deploymentVariableSummary', error: 'deploymentVariableError', add: 'addDeploymentVariable', ...options };
    const form = document.getElementById(ids.form);
    if (!form) return;
    const list = document.getElementById(ids.list);
    const file = document.getElementById(ids.file);
    const summary = document.getElementById(ids.summary);
    const error = document.getElementById(ids.error);
    const showError = message => { error.textContent = message || ''; error.hidden = !message; };
    const rows = () => [...list.querySelectorAll('[data-variable-row]')];
    const updateSummary = () => { summary.textContent = rows().length
      ? `${rows().length} variable(s) : ${rows().map(row => row.querySelector('[name="variableNames"]').value || 'sans nom').join(', ')}`
      : 'Aucune variable ajoutée.'; };
    const add = (name = '', value = '') => {
      const row = document.createElement('div');
      row.dataset.variableRow = 'true';
      row.style.cssText = 'display:flex;gap:8px;margin:8px 0;align-items:center';
      const key = document.createElement('input');
      key.name = 'variableNames'; key.placeholder = 'NOM'; key.value = name; key.required = true;
      key.autocomplete = 'off'; key.setAttribute('aria-label', 'Nom de variable');
      const secret = document.createElement('input');
      secret.name = 'variableValues'; secret.type = 'password'; secret.placeholder = 'Valeur'; secret.value = value;
      secret.autocomplete = 'new-password'; secret.setAttribute('aria-label', 'Valeur de variable');
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'btn btn-ghost btn-sm'; remove.textContent = 'Retirer';
      remove.addEventListener('click', () => { row.remove(); updateSummary(); showError(''); });
      key.addEventListener('input', updateSummary);
      row.append(key, secret, remove); list.append(row); updateSummary();
    };
    document.getElementById(ids.add).addEventListener('click', () => add());
    file.addEventListener('change', async () => {
      showError('');
      const selected = file.files?.[0];
      if (!selected) return;
      try {
        if (!selected.name.endsWith('.env') && !selected.name.endsWith('.env.local')) throw new Error('Choisissez un fichier .env.');
        if (selected.size > 65536) throw new Error('Fichier .env trop volumineux (64 Ko maximum).');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(await selected.arrayBuffer());
        const imported = parseDotEnv(text);
        const current = new Set(rows().map(row => row.querySelector('[name="variableNames"]').value));
        if (rows().length + imported.length > 50) throw new Error('Trop de variables (maximum 50).');
        const duplicate = imported.find(item => current.has(item.name));
        if (duplicate) throw new Error(`Variable ${duplicate.name} déjà saisie. Corrigez le doublon avant import.`);
        imported.forEach(item => add(item.name, item.value));
      } catch (cause) { showError(cause.message === 'The encoded data was not valid for encoding utf-8'
        ? 'Fichier .env non UTF-8.' : cause.message); }
      file.value = '';
    });
    form.addEventListener('submit', event => {
      showError('');
      const seen = new Set();
      for (const row of rows()) {
        const name = row.querySelector('[name="variableNames"]').value;
        if (!NAME.test(name) || RESERVED.test(name) || seen.has(name)) {
          event.preventDefault(); showError(`Nom de variable invalide, réservé ou en doublon : ${name}.`); return;
        }
        seen.add(name);
      }
    });
    updateSummary();
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { parseDotEnv };
  if (root?.document) root.CNPDeploymentVariables = { init, parseDotEnv };
})(globalThis.window || null);
