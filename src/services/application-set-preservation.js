'use strict';

// Une base locale incomplète ne doit jamais retirer les applications d'autrui.
function additivePatch(existing, requestedPaths) {
  const spec = existing.spec;
  const git = spec?.generators?.[0]?.git;
  if (spec?.generators?.length !== 1 || !git
    || git.repoURL !== 'https://github.com/Mooroon5-CNP/config-repo.git'
    || git.revision !== 'main' || !Array.isArray(git.directories)
    || !existing.metadata?.resourceVersion) throw new Error('ApplicationSet inattendu : revue nécessaire.');
  const directories = git.directories.map(entry => ({ ...entry }));
  for (const path of requestedPaths) {
    if (directories.some(entry => entry.exclude && entry.path === path)) {
      throw new Error('Sélection explicitement exclue : revue nécessaire.');
    }
    if (!directories.some(entry => entry.path === path && !entry.exclude)) directories.push({ path });
  }
  return [
    { op: 'test', path: '/metadata/resourceVersion', value: existing.metadata.resourceVersion },
    { op: 'replace', path: '/spec/generators/0/git/directories', value: directories },
    { op: 'add', path: '/spec/syncPolicy', value: {
      ...spec.syncPolicy, preserveResourcesOnDeletion: true, applicationsSync: 'create-update',
    } },
  ];
}
module.exports = { additivePatch };
