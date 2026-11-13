'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const script = name => fs.readFileSync(path.join(__dirname, '../public/js', name), 'utf8');

test('deploy handoff only prefills the existing form and opens its modal', () => {
    const elements = {
        githubRepoUrl: {}, appName: {}, appPort: {}, openNewDeployment: { click: jest.fn() },
    };
    vm.runInNewContext(script('repository-deploy-link.js'), {
        URLSearchParams,
        window: { location: { hash: '#repository=https%3A%2F%2Fgithub.com%2Fteam%2Fdemo&port=9000' } },
        document: { getElementById: id => elements[id] },
    });
    expect(elements.githubRepoUrl.value).toBe('https://github.com/team/demo');
    expect(elements.appName.value).toBe('demo');
    expect(elements.appPort.value).toBe(9000);
    expect(elements.openNewDeployment.click).toHaveBeenCalledTimes(1);
});

test.each(['', '#repository=javascript%3Aalert(1)', '#repository=https%3A%2F%2Fother.example%2Fteam%2Fdemo'])('ignores unrelated or invalid handoff: %s', hash => {
    const getElementById = jest.fn();
    vm.runInNewContext(script('repository-deploy-link.js'), {
        URLSearchParams, window: { location: { hash } }, document: { getElementById },
    });
    expect(getElementById).not.toHaveBeenCalled();
});

test.each([['no', 'no', 'SQLite'], ['yes', 'no', 'PostgreSQL'], ['no', 'yes', 'PostgreSQL']])('guidance for %s concurrency / %s failover recommends %s without changing selection', (concurrency, availability, expected) => {
    const elements = {
        concurrency: { value: concurrency, addEventListener: jest.fn() },
        availability: { value: availability, addEventListener: jest.fn() },
        recommendation: {}, template: { value: 'user-choice' }, repositoryError: { hidden: true },
    };
    vm.runInNewContext(script('repository-create.js'), {
        document: { getElementById: id => elements[id], querySelector: () => ({ addEventListener: jest.fn() }) },
    });
    elements.concurrency.addEventListener.mock.calls[0][1]();
    expect(elements.recommendation.textContent).toContain(expected);
    expect(elements.template.value).toBe('user-choice');
});

test('invalid repo name displays a French error next to the creation button without submitting', () => {
    const error = { hidden: true, focus: jest.fn() };
    const elements = {
        concurrency: { addEventListener: jest.fn() }, availability: { addEventListener: jest.fn() }, repositoryError: error,
    };
    const form = { addEventListener: jest.fn(), querySelector: () => ({ name: 'name' }) };
    vm.runInNewContext(script('repository-create.js'), {
        document: { getElementById: id => elements[id], querySelector: () => form },
    });
    const event = { preventDefault: jest.fn() };
    form.addEventListener.mock.calls[0][1](event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain('Nom invalide : 2 à 39 caractères');
    expect(error.focus).toHaveBeenCalled();
});
