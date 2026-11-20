'use strict';

// Le provisionneur tourne sans base SQLite ni disque inscriptible : ses modules ne doivent jamais charger les modèles
// du portail à l'import (SQLITE_CANTOPEN au démarrage, 21/11/2026).
jest.mock('../src/models/db', () => { throw new Error('base SQLite chargée par le provisionneur'); });

test('les modules du provisionneur se chargent sans la base du portail', () => {
  jest.isolateModules(() => {
    expect(() => require('../src/services/openbao-gcp-identity')).not.toThrow();
    expect(() => require('../src/services/openbao-azure-identity')).not.toThrow();
    expect(() => require('../src/services/openbao-aws-identity')).not.toThrow();
  });
});
