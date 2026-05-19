import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// All `/api/*` calls from the React app are forwarded to the Node.js backend
// (see `server/index.js`). The `ws: true` option keeps the SSE EventSource
// connection alive in dev — Vite still proxies the long-running HTTP/1.1
// response correctly when this is enabled.
export default defineConfig({
    plugins: [react()],
    server: {
        proxy: {
            '/api': {
                target: process.env.VITE_API_TARGET || 'http://localhost:3000',
                changeOrigin: true,
                ws: true,
            },
        },
    },
})
