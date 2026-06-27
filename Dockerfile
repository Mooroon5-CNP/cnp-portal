FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN apk add --no-cache --virtual .build-deps python3=3.12.13-r0 make=4.4.1-r3 g++=15.2.0-r2 build-base=0.5-r3 linux-headers=6.16.12-r0 sqlite-dev=3.51.2-r0 \
  && PYTHON=/usr/bin/python3 npm ci --only=production \
  && apk add --no-cache sqlite-libs=3.51.2-r0 \
  && apk del .build-deps \
  && npm cache clean --force

FROM node:20-alpine AS final
WORKDIR /app

RUN apk add --no-cache tini=0.19.0-r3 \
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
