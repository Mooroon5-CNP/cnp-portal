'use strict';

const commands = Object.freeze([
  { command: '/applications', title: 'Applications', description: 'Lister les applications accessibles', tool: 'list_applications', prompt: 'Liste les applications disponibles' },
  { command: '/deploiement', title: 'Déploiement', description: 'État, version et synchronisation de l’application sélectionnée', tool: 'get_deployment_status', prompt: 'Quel est le statut du déploiement ?' },
  { command: '/logs', title: 'Logs', description: 'Consulter les logs récents de l’application sélectionnée', tool: 'get_application_logs', prompt: 'Montre les logs' },
  { command: '/finops', title: 'FinOps', description: 'Utilisation et recommandation de ressources', tool: 'get_finops_recommendation', prompt: 'Donne une recommandation FinOps' },
  { command: '/gcp', title: 'Google Cloud', description: 'Question Google Cloud (Gemini Cloud Assist, managers uniquement)', tool: 'gcp_cloud_assist', capability: 'ask_cloud_assist', prompt: 'Question Google Cloud :' },
  { command: '/diagnostic', title: 'Diagnostic', description: 'Diagnostic croisé Argo CD, Datadog et Gemini Cloud Assist (managers uniquement)', tool: 'gcp_cloud_assist', capability: 'investigate_issue', transverse: true, prompt: 'Diagnostique un incident :' },
]);
function resolveCommand(message) {
  const [name, ...rest] = message.trim().split(/\s+/);
  const aliases = { '/deploiment': '/deploiement', '/deployment': '/deploiement' };
  const normalized = name.toLowerCase();
  const command = commands.find((item) => item.command === (aliases[normalized] || normalized));
  return command ? {
    tool: command.tool, message: `${command.prompt} ${rest.join(' ')}`.trim(),
    ...(command.capability ? { capability: command.capability, transverse: Boolean(command.transverse) } : {}),
  } : null;
}
module.exports = { commands, resolveCommand };
