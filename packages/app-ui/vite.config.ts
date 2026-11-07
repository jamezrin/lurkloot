import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// `pnpm dev` proxies /v1 to a running `lurkloot serve`, so the app and the API
// share one origin, as they will once serve hosts the app itself (#980).
// The proxy forwards the request unchanged: its Host stays localhost:<vite
// port>, a loopback name, and matches the page's Origin, so serve's Host and
// Origin checks pass without rewriting either.
//
// `pnpm dev:fixture` answers /v1 from fixture/controlPlane.ts instead, with
// the popup's demo data and no serve, Twitch or Kick at all.
const SERVE_URL = process.env.LURKLOOT_SERVE_URL ?? "http://127.0.0.1:8420";

function fixtureControlPlane(): Plugin {
  return {
    name: "lurkloot-fixture-control-plane",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (!request.url?.startsWith("/v1/")) return next();
        try {
          const { handleFixtureRequest } = (await server.ssrLoadModule(
            "/fixture/controlPlane.ts",
          )) as typeof import("./fixture/controlPlane");
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(chunk as Buffer);
          const text = Buffer.concat(chunks).toString("utf8");
          const answer = await handleFixtureRequest(
            request.method ?? "GET",
            request.url,
            text ? JSON.parse(text) : undefined,
            request.headers.authorization,
          );
          response.writeHead(answer.status, { "content-type": "application/json" });
          response.end(JSON.stringify(answer.body));
        } catch (error) {
          next(error);
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), ...(mode === "fixture" ? [fixtureControlPlane()] : [])],
  // Relative asset URLs, so serve can host the bundle under any path (#980).
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    // One bundle served from the user's own machine (#980), not a page on
    // the web: the popup's views are one chunk, the locales split out.
    chunkSizeWarningLimit: 1500,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: false,
    proxy: mode === "fixture" ? undefined : { "/v1": { target: SERVE_URL } },
  },
}));
