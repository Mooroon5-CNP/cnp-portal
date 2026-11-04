/* eslint-env browser */
(function(root) {
  'use strict';
  const reserved = /^(PORT|HOST|DATA_DIR|DD_ENV|DD_SERVICE|DD_VERSION|LOG_LEVEL|CNP_VARIABLES_.*|CNP_OPENBAO_.*)$/;
  function validate(rows) {
    if (rows.length > 100) throw new Error('Maximum de 100 variables.');
    const names = new Set(); let size = 0;
    for (const row of rows) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.name) || row.name.length > 128) throw new Error('Renseignez un nom valide pour chaque variable.');
      if (names.has(row.name)) throw new Error('Les noms de variables doivent être uniques.'); names.add(row.name);
      if (reserved.test(row.name)) throw new Error(`${row.name} est gérée automatiquement par la plateforme.`);
      const bytes = new TextEncoder().encode(row.value).length;
      if (row.value.includes('\0') || bytes > 32768) throw new Error('Une valeur est invalide ou dépasse 32 Kio.');
      size += new TextEncoder().encode(row.name).length + bytes;
      if (size > 65536) throw new Error('Maximum de 64 Kio de variables.');
    }
  }
  // Parse dotenv data only: never execute shell expressions or expand references.
  function parseFile(text, skipped = []) {
    const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n'); const result = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#')) continue;
      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) throw new Error(`Ligne ${i + 1} : utilisez NOM=valeur.`);
      let value = match[2]; const quote = value[0];
      if (quote === '"' || quote === "'") {
        let raw = value.slice(1); let end = -1;
        while (end < 0) {
          for (let j = 0; j < raw.length; j++) {
            if (raw[j] !== quote) continue;
            let escapes = 0;
            if (quote === '"') for (let k = j - 1; k >= 0 && raw[k] === '\\'; k--) escapes++;
            if (escapes % 2 === 0) { end = j; break; }
          }
          if (end >= 0) break;
          if (++i >= lines.length) throw new Error('Valeur entre guillemets non terminée.');
          raw += '\n' + lines[i];
        }
        if (!/^\s*(?:#.*)?$/.test(raw.slice(end + 1))) throw new Error(`Ligne ${i + 1} : contenu après les guillemets.`);
        value = raw.slice(0, end);
        if (quote === '"') value = value.replace(/\\([nrt"\\])/g, (_, char) => ({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' })[char]);
      } else value = value.replace(/#.*$/, '').trim();
      if (reserved.test(match[1])) skipped.push(match[1]);
      else result.push({ name: match[1], value, action: 'set' });
    }
    if (!result.length && !skipped.length) throw new Error('Le fichier ne contient aucune variable.');
    validate(result); return result;
  }
  function summary(rows) { return rows.map(row => `${row.name} — ${row.action === 'remove' ? 'suppression' : row.action === 'keep' ? 'inchangée' : row.value === '' ? 'valeur vide' : 'secret'}`); }
  let capabilityPromise;
  function capability(refresh) {
    if (!capabilityPromise || refresh) capabilityPromise = fetch('/deployments/variables/capability', { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then(response => { if (!response.ok) throw new Error('unavailable'); return response.json(); })
      .catch(() => ({ available: false, message: 'Vérification indisponible. Rechargez la page ou contactez un administrateur.' }));
    return capabilityPromise;
  }
  function editor(element, changed) {
    const rows = element.querySelector('[data-variable-rows]'); const add = element.querySelector('[data-add-variable]');
    const file = element.querySelector('[data-variable-file]'); const importButton = element.querySelector('[data-import-variables]');
    const importStatus = element.querySelector('[data-import-status]');
    const status = element.querySelector('[data-variable-status]'); const retry = element.querySelector('[data-check-variables]');
    let importGeneration = 0;
    let enabled = true; let checked = false; let available = false; let checking = false;
    const entries = () => Array.from(rows.children).map(row => ({ name: row.querySelector('[name="variableName"]').value,
      value: row.querySelector('[name="variableValue"]').value, action: row.querySelector('[name="variableAction"]').value }));
    const hasSets = () => entries().some(row => row.action === 'set');
    function update() {
      add.disabled = !enabled; if (importButton) importButton.disabled = !enabled;
      if (!enabled) status.textContent = 'Les variables additionnelles sont disponibles pour Cloud Run GCP dans cette version.';
      else if (!hasSets()) status.textContent = 'Aucune nouvelle valeur à stocker.';
      else if (checking) status.textContent = 'Vérification du stockage sécurisé…';
      else if (available) status.textContent = 'Permissions de stockage vérifiées.';
      retry.hidden = !enabled || !hasSets() || checking || available;
      changed();
    }
    async function check(refresh) {
      if (!enabled || !hasSets() || (checked && !refresh) || checking) return;
      checking = true; update();
      const result = await capability(refresh);
      checking = false; checked = true; available = result.available === true;
      status.textContent = result.message; update();
    }
    function addRow(name = '', existing = false) {
      const row = document.createElement('div'); row.className = 'variable-row';
      row.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px;';
      row.innerHTML = '<input name="variableName" aria-label="Nom de variable" placeholder="NOM_VARIABLE" style="flex:1;min-width:150px;" required>'
        + '<input name="variableValue" type="password" aria-label="Valeur de variable" placeholder="Valeur" autocomplete="new-password" style="flex:1;min-width:150px;">'
        + '<textarea data-multiline rows="3" aria-label="Valeur multiligne" autocomplete="off" spellcheck="false" style="width:100%;" hidden></textarea>'
        + '<input name="variableAction" type="hidden">'
        + '<button type="button" data-multiline-button class="btn btn-ghost btn-sm">Multiligne</button>'
        + '<button type="button" data-show class="btn btn-ghost btn-sm">Afficher</button>'
        + '<button type="button" data-replace class="btn btn-secondary btn-sm">Remplacer</button>'
        + '<button type="button" data-remove class="btn btn-ghost btn-sm">Supprimer</button>';
      const key = row.querySelector('[name="variableName"]'); const single = row.querySelector('[name="variableValue"]'); const multi = row.querySelector('[data-multiline]');
      let value = single; let multiline = false;
      const action = row.querySelector('[name="variableAction"]'); const replace = row.querySelector('[data-replace]'); const remove = row.querySelector('[data-remove]');
      key.value = name; key.readOnly = existing; value.readOnly = existing; action.value = existing ? 'keep' : 'set'; replace.hidden = !existing;
      if (existing) value.placeholder = 'Valeur enregistrée (non affichée)';
      const show = row.querySelector('[data-show]');
      function mask() {
        if (multiline) { multi.hidden = true; single.hidden = false; single.value = multi.value ? '••••••••' : ''; single.readOnly = true; }
        else single.type = 'password';
        show.textContent = 'Afficher';
      }
      function promote(raw) {
        multiline = true; multi.value = raw; multi.name = 'variableValue'; single.name = '';
        multi.readOnly = action.value !== 'set'; multi.hidden = false; single.hidden = true; value = multi;
        show.textContent = 'Masquer';
      }
      row.maskSecret = mask;
      row.setImportedValue = raw => {
        action.value = 'set'; replace.disabled = false; remove.textContent = 'Supprimer'; row.style.opacity = '1';
        if (/[\r\n]/.test(raw) || multiline) promote(raw);
        else { value.value = raw; value.readOnly = false; }
        mask();
      };
      row.querySelector('[data-multiline-button]').addEventListener('click', () => { promote(value.value); multi.focus(); update(); });
      single.addEventListener('paste', event => {
        const raw = event.clipboardData?.getData('text/plain');
        if (!raw || !/[\r\n]/.test(raw) || single.readOnly) return;
        event.preventDefault();
        promote(single.value.slice(0, single.selectionStart) + raw + single.value.slice(single.selectionEnd)); mask(); single.focus(); update();
      });
      show.addEventListener('click', () => {
        if (multiline) { if (multi.hidden) promote(multi.value); else mask(); }
        else { single.type = single.type === 'password' ? 'text' : 'password'; show.textContent = single.type === 'password' ? 'Afficher' : 'Masquer'; }
      });
      replace.addEventListener('click', () => { action.value = 'set'; value.readOnly = false; if (multiline) promote(value.value); else mask(); value.placeholder = 'Nouvelle valeur'; value.focus(); check(); update(); });
      remove.addEventListener('click', () => {
        value.value = '';
        if (!existing) row.remove();
        else { const removing = action.value !== 'remove'; action.value = removing ? 'remove' : 'keep'; value.readOnly = true; replace.disabled = removing; remove.textContent = removing ? 'Annuler' : 'Supprimer'; row.style.opacity = removing ? '.55' : '1'; }
        update();
      });
      row.addEventListener('input', update); rows.appendChild(row); check(); update(); return row;
    }
    add.addEventListener('click', () => { if (rows.children.length < 100) addRow(); });
    if (file && importButton) {
      importButton.addEventListener('click', () => { if (enabled) file.click(); });
      file.addEventListener('change', async () => {
        const selected = file.files[0]; if (!selected || !enabled) return;
        const generation = ++importGeneration;
        importStatus.textContent = '';
        try {
          if (!/\.(env|txt)$/i.test(selected.name)) throw new Error('Choisissez un fichier .env ou .txt.');
          if (selected.size > 262144) throw new Error('Le fichier dépasse 256 Kio.');
          const skipped = [];
          const imported = parseFile(await selected.text(), skipped);
          if (!enabled || generation !== importGeneration) return;
          const blankRows = Array.from(rows.children).filter(row => !row.querySelector('[name="variableName"]').value.trim() && !row.querySelector('[name="variableValue"]').value && row.querySelector('[name="variableAction"]').value === 'set');
          const merged = new Map(entries().filter(item => item.name.trim() || item.value || item.action !== 'set').map(item => [item.name, item]));
          imported.forEach(item => merged.set(item.name, item)); validate([...merged.values()]);
          blankRows.forEach(row => row.remove());
          for (const item of imported) {
            const row = Array.from(rows.children).find(candidate => candidate.querySelector('[name="variableName"]').value === item.name) || addRow(item.name);
            row.setImportedValue(item.value);
          }
          importStatus.textContent = `${imported.length} variable(s) importée(s).${skipped.length ? ` Variables gérées par la plateforme ignorées : ${[...new Set(skipped)].join(', ')}.` : ''} Vérifiez les champs avant de déployer.`;
          check(); update();
        } catch (failure) { importStatus.textContent = failure.message || 'Lecture du fichier impossible.'; }
        finally { file.value = ''; }
      });
    }
    retry.addEventListener('click', () => { checked = false; check(true); });
    for (const name of JSON.parse(element.dataset.existingVariables || '[]')) addRow(name, true);
    update();
    return { entries, validate: () => validate(entries()), summary: () => summary(entries()),
      ready: () => (!entries().length || enabled) && (!hasSets() || (!checking && available)),
      hasChanges: () => entries().some(row => row.action !== 'keep'),
      setEnabled: value => { enabled = value; if (enabled) check(); update(); },
      mask: () => Array.from(rows.children).forEach(row => row.maskSecret()),
      clear: () => { importGeneration++; if (file) file.value = ''; if (importStatus) importStatus.textContent = ''; rows.querySelectorAll('[name="variableValue"]').forEach(input => { input.value = ''; }); rows.replaceChildren(); update(); } };
  }
  root.CNPVariables = { editor, validate, summary, parseFile };
  if (typeof module !== 'undefined' && module.exports) module.exports = { validate, summary, parseFile };
})(typeof window === 'undefined' ? globalThis : window);
