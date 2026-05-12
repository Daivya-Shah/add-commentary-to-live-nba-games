import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./ui/src/test/setup.ts"],
    include: ["ui/src/**/*.{test,spec}.{ts,tsx}", "extension/**/*.{test,spec}.{ts,tsx}"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./ui/src"),
      "@extension": path.resolve(__dirname, "./extension"),
    },
  },
});
