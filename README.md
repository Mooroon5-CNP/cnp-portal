# test_app — End-to-end test app for the CNP CI pipeline

This is a minimal Node.js/Express app that satisfies every CNP contract requirement.
Use it to test the CI pipeline before building your real application.

## Project structure

```
test_app/
├── src/
│   └── index.js          Express app with /, /healthz, /ready endpoints
├── test/
│   └── index.test.js     Jest tests (uses supertest)
├── package.json
├── .eslintrc.js
├── Dockerfile            node:20-alpine, non-root user, EXPOSE 8080
├── .dockerignore
└── .gitlab-ci.yml        Uses the ci-templates pipeline
```

## First-time setup (run this locally before your first push)

```bash
cd test_app/
npm install          # generates package-lock.json — commit this file!
npm run lint         # should pass with no errors
npm test             # should pass: 5 tests across 3 suites
```

Then commit the lockfile:
```bash
git add package-lock.json
git commit -m "chore(test-app): add package-lock.json"
```

> **Why?** The CI pipeline uses `npm ci`, which requires `package-lock.json`
> to be committed. Without it, the lint and test jobs will fail.

## Run the app locally

```bash
npm install
node src/index.js
# or: npm start
```

Then test it:
```bash
curl http://localhost:8080/
# {"message":"Hello from test_app!","service":"test-app","version":"1.0.0","env":"dev"}

curl http://localhost:8080/healthz
# 200 OK

curl http://localhost:8080/ready
# 200 OK
```

## What the pipeline checks on this app

| Stage | Job | Expected result |
|---|---|---|
| `lint` | `lint-eslint` | Passes — no ESLint errors |
| `lint` | `lint-hadolint` | Passes — Dockerfile uses node:20-alpine, non-root user |
| `test` | `test` | Passes — 5 Jest tests all green |
| `scan-secu` | `scan-secrets` | Passes — no secrets in git history |
| `scan-secu` | `scan-deps` | Passes (unless a new CVE is published in express or jest) |
| `build` | `build` | Passes — image pushed to registry |
| `push` | `scan-image` | Passes — Alpine images have very few CVEs |
| `push` | `update-config-dev` | Passes — updates dev kustomization |
