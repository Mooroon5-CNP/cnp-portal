# CNP-compliant Dockerfile for a Node.js/Express application.
# Base image: node:20-alpine (required by CNP contracts — no ubuntu, no node:latest).
FROM node:20-alpine

WORKDIR /app

# Copy dependency manifests first so Docker layer cache is used when only
# source code changes (not dependencies).
COPY package*.json ./

# Install production dependencies only — dev tools (eslint, jest) stay out.
RUN npm ci --only=production

# Copy application source code.
COPY src/ ./src/

# Create a non-root user and switch to it (required by CNP contracts).
RUN adduser -D appuser
USER appuser

# Declare the port the application listens on.
EXPOSE 8080

# Start the application.
CMD ["node", "src/index.js"]
