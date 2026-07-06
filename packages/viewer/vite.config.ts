import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import svgr from 'vite-plugin-svgr';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';

const SITE_DATA_DIR = path.resolve(import.meta.dirname, '../../site/data');

/**
 * Dev-only: serve site/data/*.js (scanner output) at /data/* so `vite dev`
 * sees the same window.__ATLAS_DATA__ globals as the built site.
 */
function serveAtlasData(): Plugin {
  return {
    name: 'serve-atlas-data',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0] ?? '';
        if (url.startsWith('/data/') && url.endsWith('.js')) {
          const file = path.join(SITE_DATA_DIR, path.basename(url));
          if (existsSync(file)) {
            res.setHeader('Content-Type', 'application/javascript');
            createReadStream(file).pipe(res);
            return;
          }
          // No scan data yet: serve an empty stub so the app still loads.
          res.setHeader('Content-Type', 'application/javascript');
          res.end('/* no scan data yet — run: npm run scan */');
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  // Relative URLs — required for file:// double-click opening.
  base: './',
  plugins: [react(), svgr(), viteSingleFile(), serveAtlasData()],
  build: {
    // The committed single-file viewer lives at site/index.html, next to the
    // scanner-owned site/data/ directory. Never wipe the latter.
    outDir: '../../site',
    emptyOutDir: false,
  },
  preview: {
    open: true,
  },
});
