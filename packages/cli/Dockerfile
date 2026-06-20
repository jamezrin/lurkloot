# syntax=docker/dockerfile:1
#
# Headless Lurkloot CLI image. Both transports (http, impersonate) are pure
# Node + cycletls, so no browser is needed — this is a slim Node image.

# --- Build stage: install the cli + core + shared subtree and bundle the CLI ---
FROM node:24-slim AS build
WORKDIR /repo
RUN corepack enable
# cycletls downloads a small Go helper binary on install; needs CA certs.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Only the manifests first, for a cached install layer.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
# --ignore-scripts: cycletls and esbuild both ship working prebuilt binaries in
# their tarballs, so no install scripts are needed — and skipping them avoids
# pnpm 10's interactive build-approval gate in a non-interactive build.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @lurkloot/cli...

# Then the sources for the three packages the CLI actually needs.
COPY packages/shared/ packages/shared/
COPY packages/core/ packages/core/
COPY packages/cli/ packages/cli/
RUN pnpm --filter @lurkloot/cli build

# Produce a self-contained /app: the bundle plus the production node_modules for
# the externalized dep (cycletls).
RUN pnpm --filter @lurkloot/cli deploy --legacy --prod /app

# --- Runtime stage ---
FROM node:24-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
ENV NODE_ENV=production

# Mount a data dir holding config.json (and the auth/ produced by `login`).
# `run` is the default; override the command for discover/validate-config/etc.
WORKDIR /data
ENTRYPOINT ["node", "/app/dist/index.mjs"]
CMD ["run", "--config", "/data/config.json"]
