const request = require('supertest');
const { app, server } = require('../src/index');

// Close the server after all tests so Jest exits cleanly
afterAll((done) => server.close(done));

describe('Health endpoints', () => {
  test('GET /healthz returns 200', async () => {
    const res = await request(app).get('/healthz');
    expect(res.statusCode).toBe(200);
  });

  test('GET /ready returns 200', async () => {
    const res = await request(app).get('/ready');
    expect(res.statusCode).toBe(200);
  });
});

describe('Application endpoints', () => {
  test('GET / returns a JSON response with a message field', async () => {
    const res = await request(app).get('/');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('message');
    expect(typeof res.body.message).toBe('string');
  });

  test('GET / returns the correct content-type', async () => {
    const res = await request(app).get('/');
    expect(res.headers['content-type']).toMatch(/json/);
  });
});

describe('Unknown routes', () => {
  test('GET /unknown returns 404', async () => {
    const res = await request(app).get('/unknown-route');
    expect(res.statusCode).toBe(404);
  });
});
