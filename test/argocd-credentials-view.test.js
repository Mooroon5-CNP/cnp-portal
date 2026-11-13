'use strict';

const ejs = require('ejs');
const path = require('path');

function render(password) {
  return ejs.renderFile(path.join(__dirname, '../src/views/argocd/index.ejs'), {
    title: 'ArgoCD', currentPage: 'argocd', user: { username: 'developer', role: 'dev' },
    can: () => false, accessRequests: [], apps: [], hasAccess: true, argoCDUiUrl: 'https://argocd.example.test',
    myRequest: { status: 'approved', argoCDUsername: 'developer', argoCDPassword: password, updatedAt: new Date().toISOString() },
  });
}

test('unreadable credentials show a regeneration instruction instead of an empty reveal button', async () => {
  const html = await render(null);
  expect(html).toContain('Le mot de passe enregistré est illisible');
  expect(html).toContain('Régénérer mes identifiants');
  expect(html).not.toContain('id="argocd-pwd-toggle"');
});

test('readable credentials remain available to the reveal control', async () => {
  const html = await render('test-password');
  expect(html).toContain('value="test-password"');
  expect(html).toContain('id="argocd-pwd-toggle"');
  expect(html).not.toContain('Le mot de passe enregistré est illisible');
});
