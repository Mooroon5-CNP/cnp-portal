'use strict';
const fs = require('fs'); const path = require('path');
function adapt(source) {
  const offset = [...source.matchAll(/^FROM .+$/gm)].at(-1)?.index;
  if (offset === undefined) throw new Error('Dockerfile sans FROM.');
  const head = source.slice(0, offset); let stage = source.slice(offset);
  if (/io\.cnp\.variables-contract/.test(stage)) throw new Error('Chargeur déjà déclaré ; vérifier sa version avant modification.');
  if (!/^FROM node:(?:2[0-9]|[3-9][0-9])[-\w.]*(?:\s+AS\s+\w+)?$/im.test(stage.split('\n')[0])) throw new Error('Installation automatique : image finale Node >=20 requise. Pour une autre image, installer un runtime compatible explicitement.');
  function read(instruction) {
    const matches = [...stage.matchAll(new RegExp(`^${instruction}\\s+(.+)$`, 'gm'))];
    if (matches.length > 1) throw new Error('Plusieurs instructions de démarrage : adaptation manuelle requise.');
    if (!matches.length) return [];
    let values; try { values = JSON.parse(matches[0][1]); } catch (_) { throw new Error('Démarrage shell non supporté automatiquement ; conserver sa sémantique manuellement.'); }
    if (!Array.isArray(values) || !values.length || values.some(value => typeof value !== 'string')) throw new Error('Démarrage exec invalide.');
    return values;
  }
  const command = [...read('ENTRYPOINT'), ...read('CMD')];
  if (!command.length) throw new Error('Commande de démarrage explicite requise.');
  stage = stage.replace(/^(ENTRYPOINT|CMD)\s+.+\n?/gm, '');
  return head + stage.trimEnd() + '\n\nCOPY .cnp/runtime/ /opt/cnp/runtime/\nLABEL io.cnp.variables-contract="1"\nENTRYPOINT ["node", "/opt/cnp/runtime/start.cjs"]\nCMD ' + JSON.stringify(command) + '\n';
}
function main() {
  const dir = path.resolve(process.argv[2] || '.'); const file = path.join(dir, 'Dockerfile');
  const next = adapt(fs.readFileSync(file, 'utf8'));
  const ignore = fs.existsSync(path.join(dir, '.dockerignore')) ? fs.readFileSync(path.join(dir, '.dockerignore'), 'utf8') : '';
  if (/^\s*(?:\.cnp\/?|\.\*|\*)\s*$/m.test(ignore)) throw new Error('.dockerignore pourrait exclure .cnp/runtime : vérifier avant adaptation.');
  fs.mkdirSync(path.join(dir, '.cnp/runtime'), { recursive: true });
  for (const name of ['start.cjs', 'variables.cjs']) fs.copyFileSync(path.join(__dirname, '../runtime', name), path.join(dir, '.cnp/runtime', name));
  fs.writeFileSync(file, next);
  console.log('Dockerfile adapté. Vérifiez le diff, construisez et testez l’image avant de la publier.');
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { adapt };
