'use strict';

const yaml = require('js-yaml');

function expected(files, app, currentNames, ownedNames) {
  const prefix = `apps/${app}/crossplane/prod/`;
  const claim = yaml.load(files[`${prefix}cloudrun-claim.yaml`] || 'null');
  const task = yaml.load(files[`${prefix}ecs-task-definition.yaml`] || 'null');
  const gcpEnv = claim?.spec?.forProvider?.template?.containers?.[0]?.env;
  let containers;
  try { containers = JSON.parse(task?.spec?.forProvider?.containerDefinitions); } catch (_) { /* invalid candidate */ }
  const awsSecrets = containers?.[0]?.secrets;
  if (!Array.isArray(gcpEnv) || !Array.isArray(containers) || containers.length !== 1
    || !Array.isArray(awsSecrets) || !Array.isArray(currentNames) || !Array.isArray(ownedNames)) {
    throw new Error('Références runtime du secours introuvables dans la publication.');
  }
  const selected = entries => entries.filter(item => currentNames.includes(item?.name));
  const gcp = selected(gcpEnv), aws = selected(awsSecrets);
  if (gcp.length !== currentNames.length || aws.length !== currentNames.length
    || new Set(gcp.map(item => item.name)).size !== currentNames.length
    || new Set(aws.map(item => item.name)).size !== currentNames.length) {
    throw new Error('Références de variables du secours incomplètes.');
  }
  return { gcp, aws, ownedNames };
}

module.exports = { expected };
