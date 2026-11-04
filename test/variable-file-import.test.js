const { parseFile } = require('../public/js/application-variables');

test('imports dotenv and text assignments with BOM, comments, export and empty values', () => {
  expect(parseFile('\uFEFF# demo\r\nexport API_KEY = abc=123 # comment\r\nEMPTY=\r\n')).toEqual([
    { name: 'API_KEY', value: 'abc=123', action: 'set' }, { name: 'EMPTY', value: '', action: 'set' },
  ]);
});
test('preserves quoted hashes, multiline secrets and literal expressions', () => {
  expect(parseFile('KEY="first\\nsecond#part"\nCERT=\'line1\nline2\'\nRAW=$(command)${KEY}').map(row => row.value))
    .toEqual(['first\nsecond#part', 'line1\nline2', '$(command)${KEY}']);
});
test.each(['KEY="unterminated', 'KEY="value" trailing', 'not an assignment', 'KEY=a\nKEY=b', '# empty', 'KEY=bad\0value'])('rejects invalid input without echoing values: %p', source => {
  expect(() => parseFile(source)).toThrow();
});
test('rejects values above the existing secret size limit', () => {
  expect(() => parseFile(`KEY=${'a'.repeat(32769)}`)).toThrow('32 Kio');
});

test('imports application variables even when a full dotenv file contains platform settings', () => {
  const skipped = [];
  expect(parseFile('PORT=3001\nLOG_LEVEL=INFO\nAPI_KEY=secret\nDATA_DIR=/data', skipped))
    .toEqual([{ name: 'API_KEY', value: 'secret', action: 'set' }]);
  expect(skipped).toEqual(['PORT', 'LOG_LEVEL', 'DATA_DIR']);
});
test('reports a file containing only platform variables without importing them', () => {
  const skipped = [];
  expect(parseFile('PORT=8080', skipped)).toEqual([]);
  expect(skipped).toEqual(['PORT']);
});

test('selecting a file populates masked fields, replaces matching names and removes blank rows', async () => {
  const element = () => ({ value: '', name: '', style: {}, listeners: {}, hidden: false, children: [],
    addEventListener(type, fn) { this.listeners[type] = fn; },
    querySelector(selector) { return this.controls?.[selector] || [...(this.inputs || []), ...Object.values(this.controls || {})].find(input => selector === `[name="${input.name}"]`); },
    appendChild(row) { this.children.push(row); row.remove = () => { this.children.splice(this.children.indexOf(row), 1); }; },
  });
  const previousDocument = global.document; const previousFetch = global.fetch;
  global.document = { createElement: () => {
    const row = element();
    row.inputs = ['variableName', 'variableValue', 'variableAction'].map(name => ({ ...element(), name }));
    row.controls = Object.fromEntries(['[data-multiline]', '[data-replace]', '[data-remove]', '[data-show]', '[data-multiline-button]'].map(key => [key, element()]));
    return row;
  } };
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ available: false }) });
  try {
    const root = element(); root.dataset = {};
    root.controls = Object.fromEntries(['[data-variable-rows]', '[data-add-variable]', '[data-variable-file]', '[data-import-variables]', '[data-import-status]', '[data-variable-status]', '[data-check-variables]'].map(key => [key, element()]));
    const editor = global.CNPVariables.editor(root, () => {});
    root.controls['[data-add-variable]'].listeners.click();
    const file = root.controls['[data-variable-file]'];
    file.files = [{ name: '.env', size: 64, text: async () => 'PORT=3001\nAPI_KEY=first\nCERT="line1\\nline2"' }];
    await file.listeners.change();
    expect(editor.entries()).toEqual([
      { name: 'API_KEY', value: 'first', action: 'set' }, { name: 'CERT', value: 'line1\nline2', action: 'set' },
    ]);
    expect(root.controls['[data-import-status]'].textContent).toContain('PORT');
    const rows = root.controls['[data-variable-rows]'].children;
    expect(rows[0].querySelector('[name="variableValue"]').type).toBe('password');
    expect(rows[1].controls['[data-multiline]'].hidden).toBe(true);
    file.files = [{ name: 'vars.txt', size: 20, text: async () => 'API_KEY=replaced' }];
    await file.listeners.change();
    expect(editor.entries()[0].value).toBe('replaced'); expect(editor.entries()).toHaveLength(2);
  } finally { global.document = previousDocument; global.fetch = previousFetch; }
});
