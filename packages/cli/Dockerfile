# syntax=docker/dockerfile:1
#
# Headless Lurkloot CLI image. The impersonate and impit transports send Kick
# through impit (a native add-on from its prebuilt binding package for the
# image's platform), cycletls through CycleTLS's Go binary (a separate GPL-3.0
# program the CLI starts and talks to over a local socket, shipped as
# dist/cycletls/ with its license and a NOTICE), and http through Node's own
# fetch; Kick's viewer connection uses ws. No browser is needed.
# `serve` also serves the app UI, built here and shipped as static files.

# --- Build stage: install the CLI's workspace subtree, bundle the CLI and build the app UI ---
FROM node:26-slim AS build
WORKDIR /repo
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Only the manifests first, for a cached install layer.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
# Node 25 and later no longer bundle corepack, so install pnpm directly, at the
# version the root package.json's packageManager field names (as CI does).
RUN npm install -g "$(node -p 'require("./package.json").packageManager')"
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/locales/package.json packages/locales/
COPY packages/popup-ui/package.json packages/popup-ui/
COPY packages/app-ui/package.json packages/app-ui/
COPY packages/cli/package.json packages/cli/
# --ignore-scripts: cycletls (the build-time source of CycleTLS's Go binary) and
# esbuild ship working prebuilt binaries in their tarballs, and impit in
# platform packages, so no install scripts are needed — and skipping them
# avoids pnpm's build-approval check for dependency install scripts in a
# non-interactive build.
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

# Produce a self-contained /app: the bundle, CycleTLS's binary in dist/cycletls/,
# and the production node_modules for the externalized runtime deps (impit and
# ws). The cycletls npm package is a build-time dependency only: its GPL-3.0
# JavaScript is neither bundled nor in the runtime node_modules, which the
# check below enforces (#1031).
RUN pnpm --filter @lurkloot/cli deploy --legacy --prod /app
RUN cd packages/cli \
    && node scripts/checkNoGplJavaScript.mjs --metafile dist/bundle-meta.json --node-modules /app/node_modules \
    && test -x /app/dist/cycletls/cycletls \
    && rm -f /app/dist/bundle-meta.json

# --- Runtime stage ---
FROM node:26-slim
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
