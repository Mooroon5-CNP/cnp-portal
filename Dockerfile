FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
# hadolint ignore=DL3018
RUN apk add --no-cache --virtual .build-deps python3 make g++ build-base linux-headers sqlite-dev \
  && PYTHON=/usr/bin/python3 npm ci --only=production \
  && apk add --no-cache sqlite-libs \
  && apk del .build-deps \
  && npm cache clean --force

# Moteur failover (scripts/failover) : Python et ses bibliothèques figées, dans un environnement isolé copié tel quel dans
# l'image finale (même base, donc même /usr/bin/python3). Le portail lance operate.py et render.py avec ce Python.
FROM node:22-alpine AS failover
# hadolint ignore=DL3018
RUN apk add --no-cache python3
COPY scripts/failover/engine/requirements.txt scripts/failover/engine/requirements.automation.txt scripts/failover/engine/requirements.platform.txt /tmp/failover/
RUN python3 -m venv /opt/failover \
  && /opt/failover/bin/pip install --no-cache-dir -r /tmp/failover/requirements.platform.txt \
  && /opt/failover/bin/python -m pip uninstall -y pip \
  && find /opt/failover -name '__pycache__' -prune -exec rm -rf {} +

FROM node:22-alpine AS final
WORKDIR /app

# npm/yarn/corepack come with the base image but are never used at runtime
# (tini starts node directly). They are removed because the npm bundled in
# the base image carries a vulnerable tar (CVE-2026-59873, CRITICAL) that
# fails the pipeline's scan-image job. See DEVELOPER_GUIDE.md §2.
# hadolint ignore=DL3018
RUN apk add --no-cache tini python3 \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
            /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
            /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node apps/ ./apps/
COPY --chown=node:node packages/ ./packages/
COPY --chown=node:node src/ ./src/
# Opérateur et moteur failover (moteur, générateurs, gabarits) : une seule copie, celle de ce dépôt. Tests exclus (.dockerignore).
COPY --chown=node:node scripts/failover/ ./scripts/failover/
COPY --from=failover /opt/failover /opt/failover
COPY --chown=node:node public/ ./public/
COPY --chown=node:node documentation/ ./documentation/

RUN mkdir -p /app/data && chown node:node /app/data

USER node

EXPOSE 3000

ENV NODE_ENV=production \
    PORT=3000 \
    LOG_LEVEL=INFO \
    CNP_FAILOVER_PYTHON=/opt/failover/bin/python \
    CNP_FAILOVER_OPERATOR_PYTHON=/opt/failover/bin/python \
    DD_SERVICE=cnp-portal \
    DD_VERSION=1.0.0

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
