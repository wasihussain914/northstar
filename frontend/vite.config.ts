import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Listen on the LAN address Vite prints as Network:, not only localhost.
    // The iPad loads this origin; /api is proxied on the computer, so port 8000 stays local.
    host: true,
    port: 5173,
    // NORTHSTAR_API lets a second copy (e.g. a free fake-vision test instance) use another API.
    proxy: { "/api": process.env.NORTHSTAR_API ?? "http://127.0.0.1:8000" },
    allowedHosts: ['.ngrok-free.app']
  },
});
