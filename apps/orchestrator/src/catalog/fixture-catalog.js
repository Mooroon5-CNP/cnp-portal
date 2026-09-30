'use strict';

const applications = Object.freeze([{
  applicationId: 'majoutes-api',
  name: 'Majoutes API',
  team: 'majoutes',
  repositoryUrl: 'https://git.example/majoutes-api',
  environments: [{ name: 'dev', enabled: true }, { name: 'prod', enabled: true }],
}]);

class FixtureCatalog {
  async listApplications() {
    return applications.map((application) => ({
      ...application,
      environments: application.environments.map((environment) => ({ ...environment })),
    }));
  }
}

module.exports = { FixtureCatalog };
