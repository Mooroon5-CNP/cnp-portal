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
  // Rôle d'exécution propre à l'app (render.py l'écrit avec les références) : vérifié chez AWS comme les épinglages.
  const role = task?.spec?.forProvider?.executionRoleArn;
  if (currentNames.length && !/^arn:aws:iam::[0-9]{12}:role\/cnp-runtime\/cnp-[0-9a-f]{20}-exec$/.test(role || '')) {
    throw new Error('Rôle d’exécution AWS de l’application absent de la publication.');
  }
  return currentNames.length ? { gcp, aws, ownedNames, aws_execution_role: role } : { gcp, aws, ownedNames };
}

module.exports = { expected };
