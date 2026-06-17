# syntax=docker/dockerfile:1
#
# Headless Lurkloot CLI image. The Playwright base ships the Chromium the
# `browser` transport needs; the `http` and `impersonate` transports do not need
# it, so for those swap the base for node:22-slim (see packages/cli/README.md).

# --- Build stage: install the cli + core + shared subtree and bundle the CLI ---
FROM mcr.microsoft.com/playwright:v1.60.0-jammy AS build
WORKDIR /repo
RUN corepack enable

# Only the manifests first, for a cached install layer.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
RUN pnpm install --frozen-lockfile --filter @lurkloot/cli...

# Then the sources for the three packages the CLI actually needs.
COPY packages/shared/ packages/shared/
COPY packages/core/ packages/core/
COPY packages/cli/ packages/cli/
RUN pnpm --filter @lurkloot/cli build

# Produce a self-contained /app: the bundle plus the production node_modules for
# the externalized deps (cycletls, playwright).
RUN pnpm --filter @lurkloot/cli deploy --legacy --prod /app

# --- Runtime stage ---
FROM mcr.microsoft.com/playwright:v1.60.0-jammy
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
ENV NODE_ENV=production

# Mount a data dir holding config.json (and the auth/ produced by `login`).
# `run` is the default; override the command for discover/validate-config/etc.
WORKDIR /data
ENTRYPOINT ["node", "/app/dist/index.mjs"]
CMD ["run", "--config", "/data/config.json"]
