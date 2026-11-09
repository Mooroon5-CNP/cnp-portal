'use strict';

// Un profil est « introspecté » quand son contrat SQL ne porte que le nom de la base : le schéma de l'application se lit
// dans sa base, il ne se décrit pas. Les profils historiques (profil nommé, contrat déclaratif de tables) ne le sont pas.
function isIntrospected(document) {
  const contract = document?.profile?.gcp?.sql_contract;
  return !!contract && typeof contract === 'object' && Object.keys(contract).join() === 'database';
}

module.exports = { isIntrospected };
