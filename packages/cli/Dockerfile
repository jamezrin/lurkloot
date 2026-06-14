# Headless stream-autopilot farmer. Build from the REPO ROOT:
#   docker build -f packages/cli/Dockerfile -t stream-autopilot-cli .
#
# Based on Playwright's image so the `browser` transport works out of the box.
# The `http`/`impersonate` transports also run here (cycletls ships static
# binaries). For an http/impersonate-only deployment, swap the base for
# node:22-slim to shrink the image — no Chromium needed.
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app
RUN corepack enable

# Copy the whole workspace, then install ONLY the CLI subtree (cli + core +
# shared). The extension/site React/WXT deps — and their postinstall (wxt
# prepare) — are never pulled in.
COPY . .
RUN pnpm install --frozen-lockfile --filter @stream-autopilot/cli...

# Mount a host directory with config.json here; auth/ and state.json are written
# alongside it (authDir defaults to ./auth relative to the config).
VOLUME /data

# Override the command for one-off tasks, e.g.:
#   docker run --rm -v $PWD/data:/data stream-autopilot-cli \
#     pnpm --filter @stream-autopilot/cli exec tsx src/index.ts discover --config /data/config.json
CMD ["pnpm", "--filter", "@stream-autopilot/cli", "exec", "tsx", "src/index.ts", "run", "--config", "/data/config.json"]
