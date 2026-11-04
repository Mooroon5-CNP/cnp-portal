FROM node:24-alpine
WORKDIR /app
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --chown=node:node server.cjs ./server.cjs
USER node
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.cjs"]
