import { writeFile } from 'node:fs/promises'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const TOWN_PARTS = new URL('./src/assets/structures/town-parts/', import.meta.url)
const MAX_PART_BYTES = 1 << 20

/**
 * Dev server only: POST /__town-parts/<name> writes the body to
 * src/assets/structures/town-parts/<name>.svg, so /structure-lab can save.
 */
function townPartsSave(): Plugin {
  return {
    name: 'hatchlas-town-parts-save',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__town-parts/', (request, response) => {
        const name = decodeURIComponent((request.url ?? '').replace(/^\//, '').split('?')[0])
        const reply = (status: number, message: string) => {
          response.statusCode = status
          response.setHeader('Content-Type', 'text/plain')
          response.end(message)
        }
        if (request.method !== 'POST') return reply(405, 'POST a part SVG')
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return reply(400, 'Part names are lowercase words joined by dashes')
        const chunks: Buffer[] = []
        let bytes = 0
        request.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes <= MAX_PART_BYTES) chunks.push(chunk)
        })
        request.on('end', () => {
          const svg = Buffer.concat(chunks).toString('utf8')
          if (bytes > MAX_PART_BYTES) return reply(413, 'Part is too large')
          if (!svg.startsWith('<svg') || !svg.includes('<g class="part"')) return reply(400, 'Not a town part SVG')
          writeFile(new URL(`${name}.svg`, TOWN_PARTS), svg).then(
            () => reply(200, `Saved ${name}.svg`),
            (error: Error) => reply(500, error.message),
          )
        })
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), townPartsSave()],
  assetsInclude: ["**/*.tif", "**/*.tiff"],
})
