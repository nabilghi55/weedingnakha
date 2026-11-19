import type { NextConfig } from "next";
import { networkInterfaces } from "node:os";

// Two modes:
//  - dev / `next start`: /api and /host/access are proxied to the Go API (BACKEND_URL),
//    so the browser sees one origin and the HttpOnly session cookies just work
//  - NEXT_OUTPUT=export: static HTML in ./out, served by the Go binary itself
//    (single process in production, see deploy/deploy.sh)
const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:8080";
const isExport = process.env.NEXT_OUTPUT === "export";

// dev only: this machine's LAN IPs, so a phone on the same Wi-Fi can open http://<ip>:3000
const lanIPs = Object.values(networkInterfaces())
  .flat()
  .filter((n) => n && n.family === "IPv4" && !n.internal)
  .map((n) => n!.address);

const nextConfig: NextConfig = isExport
  ? { output: "export", trailingSlash: true }
  : {
      // dev only: allow testing from a phone (same Wi-Fi, or an HTTPS tunnel via `cloudflared tunnel --url http://localhost:3000`)
      allowedDevOrigins: [...lanIPs, "*.trycloudflare.com"],
      async rewrites() {
        return {
          beforeFiles: [],
          afterFiles: [
            { source: "/api/:path*", destination: `${BACKEND_URL}/api/:path*` },
            // host token → session exchange happens on the backend (sets HttpOnly cookie, strips token)
            { source: "/host/access", destination: `${BACKEND_URL}/host/access` },
          ],
          // dev only: the admin console lives at its secret URL (/<ADMIN_PATH>/). Any unmatched
          // key-shaped path renders it; the API (X-Nakha-Admin-Key) decides whether it is real,
          // a wrong key just shows "not found". In production the Go server serves it only at
          // the exact ADMIN_PATH and 404s /admin.
          fallback: [{ source: "/:key([A-Za-z0-9_-]{16,64})", destination: "/admin" }],
        };
      },
    };

export default nextConfig;
