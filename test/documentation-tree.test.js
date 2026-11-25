'use strict';
// La barre de la page Documentation montre les dossiers (Cloud/, Platform/, Users/…) au lieu de chemins à plat.
const path = require('path');
const ejs = require('ejs');
const { buildTree } = require('../src/routes/documentation');

const files = ['Users/PLATFORM_CONTRACT.md', 'Users/DEVELOPER_GUIDE.md', 'README.md',
  'Cloud/AWS-Failover/RUNBOOK.md', 'Cloud/Azure/AZURE.md', 'Cloud/GCP/GCP.md', 'Platform/DEPLOYMENT.md', 'Users/DEVOPS_GUIDE.md'];

test('folders keep the order of their first document; documents keep the given order', () => {
  const tree = buildTree(files);
  expect(tree.files).toEqual(['README.md']);
  expect(tree.folders.map(f => f.name)).toEqual(['Users', 'Cloud', 'Platform']);
  expect(tree.folders[0].files).toEqual(['Users/PLATFORM_CONTRACT.md', 'Users/DEVELOPER_GUIDE.md', 'Users/DEVOPS_GUIDE.md']);
  const cloud = tree.folders[1];
  expect(cloud.files).toEqual([]);
  expect(cloud.folders.map(f => [f.name, f.path])).toEqual([['AWS-Failover', 'Cloud/AWS-Failover'], ['Azure', 'Cloud/Azure'], ['GCP', 'Cloud/GCP']]);
  expect(buildTree([])).toEqual({ name: '', path: '', folders: [], files: [] });
});

test('the sidebar renders nested folders, opens the current one, keeps links and the DevOps badge, runs no script', async () => {
  const html = await ejs.renderFile(path.join(__dirname, '../src/views/documentation/index.ejs'), {
    title: 'Docs', currentPage: 'docs', files, tree: buildTree(files), content: '<p>x</p>', currentFile: 'Cloud/Azure/AZURE.md',
    isDevopsFile: f => f === 'Users/DEVOPS_GUIDE.md', user: { username: 'u', role: 'manager' }, can: () => true,
    flash: {}, messages: {}, success: [], error: [], pendingCounts: {}, badges: {},
  }, { views: [path.join(__dirname, '../src/views')] });
  const sidebar = html.slice(html.indexOf('doc-sidebar'), html.indexOf('doc-content'));
  for (const name of ['Users', 'Cloud', 'AWS-Failover', 'Azure', 'GCP', 'Platform']) expect(sidebar).toContain(`📁 ${name}`);
  expect(sidebar).toMatch(/<details class="doc-folder" open>\s*<summary>📁 Cloud<\/summary>/);
  expect(sidebar).toMatch(/<details class="doc-folder" open>\s*<summary>📁 Azure<\/summary>/);
  expect(sidebar).toMatch(/<details class="doc-folder">\s*<summary>📁 GCP<\/summary>/);
  expect(sidebar).toContain('href="/docs/Cloud/Azure/AZURE.md" class="active"');
  expect(sidebar).toContain('📄 AZURE</span>');
  expect(sidebar).toContain('📄 PLATFORM CONTRACT');
  expect(sidebar).toMatch(/DEVOPS GUIDE<\/span>\s*<span[^>]*>DevOps<\/span>/);
  expect(sidebar).not.toContain('<script');
});
