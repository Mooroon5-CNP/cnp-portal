FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

FROM node:20-alpine AS final
WORKDIR /app

RUN addgroup -S cnp && adduser -S cnp -G cnp

COPY --from=deps --chown=cnp:cnp /app/node_modules ./node_modules
COPY --chown=cnp:cnp src/ ./src/
COPY --chown=cnp:cnp public/ ./public/
COPY --chown=cnp:cnp documentation/ ./documentation/

USER cnp

EXPOSE 3000

ENV NODE_ENV=production \
    PORT=3000 \
    LOG_LEVEL=INFO \
    DD_SERVICE=cnp-portal \
    DD_VERSION=1.0.0

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/healthz || exit 1

CMD ["node", "src/index.js"]
