import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [react(), cloudflare()],
  // iPhone から LAN 経由で開けるようにする。HTTPS 終端は scripts/dev-proxy.mjs が行う。
  server: { host: true, port: 5173, strictPort: true },
});
