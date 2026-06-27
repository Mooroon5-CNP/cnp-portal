FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
# hadolint ignore=DL3018
RUN apk add --no-cache --virtual .build-deps python3 make g++ build-base linux-headers sqlite-dev \
  && PYTHON=/usr/bin/python3 npm ci --only=production \
  && apk add --no-cache sqlite-libs \
  && apk del .build-deps \
  && npm cache clean --force

FROM node:20-alpine AS final
WORKDIR /app

# hadolint ignore=DL3018
RUN apk add --no-cache tini \
 && addgroup -g 1000 cnp && adduser -u 1000 -S -G cnp cnp

COPY --from=deps --chown=cnp:cnp /app/node_modules ./node_modules
COPY --chown=cnp:cnp src/ ./src/
COPY --chown=cnp:cnp public/ ./public/
COPY --chown=cnp:cnp documentation/ ./documentation/

USER 1000

EXPOSE 3000

ENV NODE_ENV=production \
    PORT=3000 \
    LOG_LEVEL=INFO \
    DD_SERVICE=cnp-portal \
    DD_VERSION=1.0.0

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
