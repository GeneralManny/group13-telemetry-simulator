import type { NextConfig } from "next";

/**
 * Production: a static export (out/) that the simulator service serves at "/", so the
 * dashboard and API share one origin and one Railway service.
 * Development: `next dev` on :3001 proxies API calls to a local simulator.
 */
const simulator = process.env.SIMULATOR_URL ?? "http://localhost:3000";
const isDev = process.env.NODE_ENV === "development";

// The dashboard has its own lockfile inside the simulator repo.
const turbopack = { root: process.cwd() };

const config: NextConfig = isDev
  ? {
      turbopack,
      async rewrites() {
        return ["/api/:path*", "/health", "/ready"].map((source) => ({
          source,
          destination: `${simulator}${source}`,
        }));
      },
    }
  : {
      turbopack,
      output: "export",
      images: { unoptimized: true },
      poweredByHeader: false,
    };

export default config;
