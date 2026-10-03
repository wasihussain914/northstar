import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // NORTHSTAR_API lets a second copy (e.g. a free fake-vision test instance) use another API.
    proxy: { "/api": process.env.NORTHSTAR_API ?? "http://127.0.0.1:8000" },
  },
});
