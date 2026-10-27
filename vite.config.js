import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// Gera um único index.html autocontido (JS e CSS embutidos), que também abre direto do disco (file://).
export default defineConfig({
  base: "./",
  plugins: [react(), viteSingleFile()],
});
