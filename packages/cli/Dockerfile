# syntax=docker/dockerfile:1
#
# Headless Lurkloot CLI image. Both transports (http, impersonate) use
# Node + cycletls; Kick's viewer connection uses ws. No browser is needed.
# `serve` also serves the app UI, built here and shipped as static files.

# --- Build stage: install the CLI's workspace subtree, bundle the CLI and build the app UI ---
FROM node:24-slim AS build
WORKDIR /repo
# Node 25 and later no longer bundle corepack, so install pnpm directly. Keep the
# version in step with the pnpm/action-setup version in the workflows.
RUN npm install -g pnpm@12.16.1
# cycletls downloads a small Go helper binary on install; needs CA certs.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Only the manifests first, for a cached install layer.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/locales/package.json packages/locales/
COPY packages/popup-ui/package.json packages/popup-ui/
COPY packages/app-ui/package.json packages/app-ui/
COPY packages/cli/package.json packages/cli/
# --ignore-scripts: cycletls and esbuild both ship working prebuilt binaries in
# their tarballs, so no install scripts are needed — and skipping them avoids
# pnpm 10's interactive build-approval gate in a non-interactive build.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @lurkloot/cli...

# Then the sources: the CLI's three packages, and the app UI with the two it
# builds from. The CLI build puts the app UI in dist/app.
COPY packages/shared/ packages/shared/
COPY packages/core/ packages/core/
COPY packages/locales/ packages/locales/
COPY packages/popup-ui/ packages/popup-ui/
COPY packages/app-ui/ packages/app-ui/
COPY packages/cli/ packages/cli/
RUN pnpm --filter @lurkloot/cli build

# Produce a self-contained /app: the bundle plus the production node_modules for
# the externalized runtime deps (cycletls and ws).
RUN pnpm --filter @lurkloot/cli deploy --legacy --prod /app

# --- Runtime stage ---
FROM node:24-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
ENV NODE_ENV=production
# `serve`'s port. Publish it on loopback (compose.yaml); see the CLI README.
EXPOSE 8420

# Mount a data dir; the CLI creates config.json and auth/ on first use.
# `run` is the default; override the command for serve/discover/validate-config/etc.
WORKDIR /data
ENTRYPOINT ["node", "/app/dist/index.mjs"]
CMD ["run", "--config", "/data/config.json"]
