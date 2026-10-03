import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// base "./": every URL relative, so the app works under Desktop's /apps/<name>/ (docs/apps.md)
export default defineConfig({
    base: "./",
    plugins: [react()],
    // graphviz's WASM chunk (~800 kB) is loaded lazily on the first graphviz layout
    build: { chunkSizeWarningLimit: 1000 },
    server: { proxy: { "/api": { target: "http://127.0.0.1:8787", ws: true } } },
})
