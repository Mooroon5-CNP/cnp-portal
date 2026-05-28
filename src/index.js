const express = require('express');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// Main route
app.get('/', (req, res) => {
  res.json({
    message: 'Hello from test_app!',
    service: process.env.DD_SERVICE || 'test-app',
    version: process.env.DD_VERSION || '1.0.0',
    env: process.env.DD_ENV || 'dev',
  });
});

// Kubernetes liveness probe — is the process alive?
app.get('/healthz', (req, res) => {
  res.sendStatus(200);
});

// Kubernetes readiness probe — is the app ready to receive traffic?
app.get('/ready', (req, res) => {
  res.sendStatus(200);
});

const server = app.listen(PORT, () => {
  // Structured JSON logging (CNP contract: JSON format, INFO level in prod)
  console.log(JSON.stringify({
    level: 'INFO',
    message: `Server listening on port ${PORT}`,
    service: process.env.DD_SERVICE || 'test-app',
  }));
});

// Export for testing with supertest
module.exports = { app, server };
