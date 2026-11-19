# NST Open Source Status: one image for the web app (API + static frontend) and the scripts (manual runs and one-off Jobs).
# Build for the cluster architecture:  docker build --platform linux/amd64 -t registry.nstsdc.org:5000/oss-status:<tag> .
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /app
RUN chown node:node /app
USER node

# Dependencies first (cached layer). The postinstall script copies Chart.js from node_modules to
# public/vendor/chart.umd.js, so the frontend never needs a CDN; `COPY public` below merges into that directory.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node public ./public
# Seed of the private readiness page: program org lists and hand-checked org aliases (src/programs.js reads them at boot).
COPY --chown=node:node config ./config

# Fail the build if the vendored chart library is missing (the pages must work without external CDNs).
RUN test -s public/vendor/chart.umd.js

EXPOSE 3000
# Numeric uid of the `node` user, so Kubernetes `runAsNonRoot` can verify it.
USER 1000

CMD ["node", "src/server.js"]
