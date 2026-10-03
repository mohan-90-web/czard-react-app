import { createReadStream } from 'node:fs'
import { cp, mkdir, stat } from 'node:fs/promises'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const projectRoot = dirname(fileURLToPath(import.meta.url))
const mediaShopRoot = resolve(projectRoot, 'media-manager/cdn/shop')
const builtShopRoot = resolve(projectRoot, 'dist/www.czard.com/cdn/shop')
const shopRequestPrefixes = ['/www.czard.com/cdn/shop/', '/cdn/shop/']
const contentTypes = {
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}

function capturedRouteAndMediaPlugin() {
  return {
    name: 'czard-local-media-and-routes',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        let pathname
        try {
          pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
        } catch {
          response.statusCode = 400
          response.end('Bad request')
          return
        }

        const shopRequestPrefix = shopRequestPrefixes.find((prefix) => pathname.startsWith(prefix))
        if (shopRequestPrefix && ['GET', 'HEAD'].includes(request.method)) {
          const relativePath = pathname.slice(shopRequestPrefix.length)
          const filePath = resolve(mediaShopRoot, relativePath)
          if (!filePath.startsWith(`${mediaShopRoot}${sep}`)) {
            response.statusCode = 403
            response.end('Forbidden')
            return
          }

          try {
            const fileStats = await stat(filePath)
            if (!fileStats.isFile()) {
              response.statusCode = 404
              response.end('Not found')
              return
            }
            response.statusCode = 200
            response.setHeader('Content-Type', contentTypes[extname(filePath).toLowerCase()] ?? 'application/octet-stream')
            response.setHeader('Content-Length', fileStats.size)
            if (request.method === 'HEAD') {
              response.end()
              return
            }
            createReadStream(filePath).pipe(response)
          } catch {
            if (shopRequestPrefix === '/cdn/shop/') {
              const queryIndex = request.url?.indexOf('?') ?? -1
              const query = queryIndex >= 0 ? request.url.slice(queryIndex) : ''
              request.url = `/www.czard.com${pathname}${query}`
            }
            next()
          }
          return
        }

        const routePrefixes = ['/products/', '/collections/', '/pages/', '/blogs/', '/policies/']
        const isCapturedRoute =
          pathname === '/cart' ||
          pathname === '/collections' ||
          routePrefixes.some((prefix) => pathname.startsWith(prefix))

        if (!isCapturedRoute || pathname.endsWith('.html')) {
          next()
          return
        }

        const routePath = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
        const queryIndex = request.url?.indexOf('?') ?? -1
        const query = queryIndex >= 0 ? request.url.slice(queryIndex) : ''
        request.url = `/www.czard.com${routePath}.html${query}`
        next()
      })
    },
    async closeBundle() {
      await mkdir(builtShopRoot, { recursive: true })
      await cp(mediaShopRoot, builtShopRoot, { recursive: true, force: true })
    },
  }
}

export default defineConfig({
  plugins: [react(), capturedRouteAndMediaPlugin()],
})
