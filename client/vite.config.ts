import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

// Custom plugin to handle SPA fallback in preview mode
function spaFallbackPlugin(): Plugin {
  return {
    name: 'spa-fallback',
    configurePreviewServer(server) {
      // Return a function to run after built-in middlewares
      return () => {
        server.middlewares.use((req, res, next) => {
          const url = req.url || ''
          // If URL doesn't have a file extension, serve index.html
          if (!path.extname(url) || url === '/worker') {
            const indexPath = path.join(server.config.root, 'dist', 'index.html')
            if (fs.existsSync(indexPath)) {
              res.setHeader('Content-Type', 'text/html')
              res.end(fs.readFileSync(indexPath, 'utf-8'))
              return
            }
          }
          next()
        })
      }
    }
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), spaFallbackPlugin()],
  assetsInclude: ['**/*.gltf', '**/*.glb'],
})
