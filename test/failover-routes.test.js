'use strict';
jest.mock('../src/services/environment-failover', () => ({ rows: jest.fn(() => []),
  prepare: jest.fn(async () => ({ id: 'candidate', head: 'abc', files: {} })),
  approve: jest.fn(async () => ({ published: true })) }));
const express = require('express');
const request = require('supertest');
const service = require('../src/services/environment-failover');
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.session = { userId: 'manager', failoverCsrf: 'review-token' };
  req.user = { id: 'manager', role: req.get('X-Test-Role') || 'manager', active: true };
  next();
});
app.use('/failover', require('../src/routes/failover'));
beforeEach(() => jest.clearAllMocks());
test('un non-manager ne peut pas préparer de candidat prod', async () => {
  expect((await request(app).post('/failover/prepare/databases').set('X-Test-Role', 'dev').send({ csrf: 'review-token' })).status).toBe(403);
  expect(service.prepare).not.toHaveBeenCalled();
});
test('un POST sans le jeton de session ne peut pas publier', async () => {
  expect((await request(app).post('/failover/candidate/approve').send({ head: 'abc' })).status).toBe(403);
  expect(service.approve).not.toHaveBeenCalled();
});
test('le manager transmet le SHA exact examiné au service de publication', async () => {
  const result = await request(app).post('/failover/candidate/approve').set('Accept', 'application/json')
    .send({ csrf: 'review-token', head: 'abc' });
  expect(result.status).toBe(200);
  expect(service.approve).toHaveBeenCalledWith('candidate', 'abc', expect.objectContaining({ id: 'manager', role: 'manager' }));
});
