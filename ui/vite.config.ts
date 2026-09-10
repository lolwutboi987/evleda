import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";

const uiRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiOrigin = env.EVLEDA_API_ORIGIN || "http://127.0.0.1:8765";

  return {
    root: uiRoot,
    plugins: [react(), tailwindcss()],
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": {
          target: apiOrigin,
          changeOrigin: false,
          configure(proxy) {
            proxy.on("error", (_error, _request, response) => {
              if ("headersSent" in response && !response.headersSent) {
                response.writeHead(503, { "Content-Type": "application/json" });
                response.end(JSON.stringify({ message: "The local EvlEDA daemon is unavailable." }));
              }
            });
          }
        }
      }
    },
    preview: {
      host: "127.0.0.1",
      port: 4173,
      strictPort: true
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      sourcemap: true
    }
  };
});
