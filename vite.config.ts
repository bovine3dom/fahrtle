import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

export default defineConfig({
  base: './',
  plugins: [solid()],
  build: {
    emptyOutDir: false, // fix broken links at the cost of a few MB of disk space
    rollupOptions: {
      output: {
        // Change from object to function to fix TS error
        manualChunks: (id) => {
          if (id.includes('maplibre-gl')) {
            return 'maplibre';
          }
          if (id.includes('@turf')) {
            return 'turf';
          }
        },
      },
    },
  },
})
