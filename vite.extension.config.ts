import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  publicDir: false,
  plugins: [
    react(),
    {
      name: "copy-extension-manifest",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "manifest.json",
          source: `{
  "manifest_version": 3,
  "name": "Vision2Voice YouTube Captions",
  "description": "Generate Vision2Voice NBA captions directly on YouTube videos and live streams.",
  "version": "0.1.0",
  "permissions": ["storage", "tabs"],
  "host_permissions": ["http://127.0.0.1/*", "http://localhost/*", "https://*/*"],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["https://www.youtube.com/*", "https://youtube.com/*"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ],
  "action": {
    "default_title": "Vision2Voice",
    "default_popup": "popup.html"
  }
}
`,
        });
        this.emitFile({
          type: "asset",
          fileName: "popup.html",
          source: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vision2Voice</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="popup.js"></script>
  </body>
</html>
`,
        });
      },
    },
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@extension": path.resolve(__dirname, "./extension"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
  },
  build: {
    outDir: "dist-extension",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        popup: path.resolve(__dirname, "extension/popup.tsx"),
        content: path.resolve(__dirname, "extension/content.ts"),
        background: path.resolve(__dirname, "extension/background.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
