'use strict';
const fs = require('fs'); const vm = require('vm'); const path = require('path');
const core = require('../public/js/application-variables');
function element() {
  return { hidden: false, disabled: false, textContent: '', children: [], listeners: {},
    addEventListener(name, callback) { this.listeners[name] = callback; },
    click() { if (!this.disabled) this.listeners.click?.({ preventDefault() {} }); },
    replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); } };
}
function fixture(ready = true) {
  const panels = [1, 2, 3].map(step => ({ ...element(), dataset: { deploymentStep: String(step) }, querySelectorAll: () => [] }));
  const keys = ['[data-wizard-storage-status]', '[data-wizard-error]', '[data-wizard-back]', '[data-wizard-next]', '[type="submit"]', '[data-wizard-progress]', '[data-deployment-summary]', '[data-variables-editor]'];
  const controls = Object.fromEntries(keys.map(key => [key, element()]));
  const form = { ...element(), action: '/deployments', querySelector: key => controls[key], querySelectorAll: () => panels,
    elements: { targetCluster: { ...element(), value: 'gcp' }, appName: { value: 'demo' }, githubRepoUrl: { value: 'https://github.com/team/demo' }, environment: { value: 'dev' }, appPort: { value: '8080' } }, reset: jest.fn() };
  const modal = element(); const rows = [{ name: 'TOKEN', value: 'hidden-test-value', action: 'set' }];
  const editor = { ready: () => ready, entries: () => rows, summary: () => core.summary(rows), validate: () => core.validate(rows), mask: jest.fn(), clear: jest.fn(), setEnabled: jest.fn() };
  const fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ redirect: '/deployments/result' }) });
  const location = { protocol: 'https:', hostname: 'portal.test', assign: jest.fn() };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/deployment-wizard.js'), 'utf8'), {
    document: { getElementById: id => id === 'newDeploymentForm' ? form : id === 'newDeploymentModal' ? modal : null, createElement: element },
    window: { CNPVariables: { editor: () => editor }, location, addEventListener: jest.fn() }, location, fetch, URLSearchParams,
    FormData: function() { return [['variableName', 'TOKEN'], ['variableValue', 'hidden-test-value'], ['variableAction', 'set']]; },
  });
  return { form, panels, controls, editor, fetch, location, modal };
}
test('next/back preserve entered variables and recap never displays their values', () => {
  const f = fixture(); const next = f.controls['[data-wizard-next]'];
  expect(f.panels[0].hidden).toBe(false); next.click(); expect(f.panels[1].hidden).toBe(false);
  next.click(); expect(f.panels[2].hidden).toBe(false);
  const summary = f.controls['[data-deployment-summary]'].children.map(child => child.textContent).join(' ');
  expect(summary).toContain('TOKEN'); expect(summary).not.toContain('hidden-test-value');
  f.controls['[data-wizard-back]'].click(); expect(f.panels[1].hidden).toBe(false); expect(f.editor.clear).not.toHaveBeenCalled();
});
test('unavailable storage allows recap but blocks sending values with an explicit explanation', async () => {
  const f = fixture(false); const next = f.controls['[data-wizard-next]'];
  next.click(); expect(next.disabled).toBe(false);
  next.click(); expect(f.panels[2].hidden).toBe(false);
  expect(f.controls['[type="submit"]'].disabled).toBe(true);
  expect(f.controls['[data-wizard-storage-status]'].hidden).toBe(false);
  expect(f.controls['[data-wizard-storage-status]'].textContent).toContain('stockage sécurisé');
  await f.form.listeners.submit({ preventDefault() {} });
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.controls['[data-wizard-error]'].textContent).toContain('stockage sécurisé');
  f.controls['[data-wizard-back]'].click(); expect(f.panels[1].hidden).toBe(false);
});
test('final submit uses POST and clears sensitive fields only after successful creation', async () => {
  const f = fixture(); f.controls['[data-wizard-next]'].click(); f.controls['[data-wizard-next]'].click();
  await f.form.listeners.submit({ preventDefault() {} });
  expect(f.fetch).toHaveBeenCalledWith('/deployments', expect.objectContaining({ method: 'POST' }));
  expect(f.editor.clear).toHaveBeenCalled(); expect(f.location.assign).toHaveBeenCalledWith('/deployments/result');
});
test('server failure retains input for retry and does not redirect', async () => {
  const f = fixture(); f.fetch.mockResolvedValue({ ok: false, json: async () => ({ error: 'Platform unavailable' }) });
  f.controls['[data-wizard-next]'].click(); f.controls['[data-wizard-next]'].click(); await f.form.listeners.submit({ preventDefault() {} });
  expect(f.editor.clear).not.toHaveBeenCalled(); expect(f.location.assign).not.toHaveBeenCalled(); expect(f.controls['[data-wizard-error]'].textContent).toBe('Platform unavailable');
});
test('front-end validation rejects duplicate names and reserved platform variables', () => {
  expect(() => core.validate([{ name: 'PORT', value: '3001' }])).toThrow();
  expect(() => core.validate([{ name: 'A', value: 'x' }, { name: 'A', value: 'y' }])).toThrow();
});

test('repeated next events cannot advance past recap or hide the deploy action', async () => {
  const f = fixture(); const next = f.controls['[data-wizard-next]'];
  for (let i = 0; i < 20; i++) next.listeners.click();
  expect(f.controls['[data-wizard-progress]'].textContent).toBe('3/3 — Récapitulatif');
  expect(f.panels.map(panel => panel.hidden)).toEqual([true, true, false]);
  expect(next.hidden).toBe(true); expect(next.disabled).toBe(true);
  expect(f.controls['[type="submit"]'].hidden).toBe(false);
  expect(f.controls['[type="submit"]'].disabled).toBe(false);
  await f.form.listeners.submit({ preventDefault() {} });
  expect(f.fetch).toHaveBeenCalledTimes(1);
});
test('button display rules cannot override the hidden attribute', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/css/style.css'), 'utf8');
  expect(css).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
});
