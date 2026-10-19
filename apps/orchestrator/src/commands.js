'use strict';

const commands = Object.freeze([
  { command: '/applications', title: 'Applications', description: 'Lister les applications accessibles', tool: 'list_applications', prompt: 'Liste les applications disponibles' },
  { command: '/deploiement', title: 'Déploiement', description: 'État, version et synchronisation de l’application sélectionnée', tool: 'get_deployment_status', prompt: 'Quel est le statut du déploiement ?' },
  { command: '/logs', title: 'Logs', description: 'Consulter les logs récents de l’application sélectionnée', tool: 'get_application_logs', prompt: 'Montre les logs' },
  { command: '/finops', title: 'FinOps', description: 'Utilisation et recommandation de ressources', tool: 'get_finops_recommendation', prompt: 'Donne une recommandation FinOps' },
]);
function resolveCommand(message) {
  const [name, ...rest] = message.trim().split(/\s+/);
  const command = commands.find((item) => item.command === name.toLowerCase());
  return command ? { tool: command.tool, message: `${command.prompt} ${rest.join(' ')}`.trim() } : null;
}
module.exports = { commands, resolveCommand };
