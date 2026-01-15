import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

export default defineConfig({
  base: './',
  plugins: [solid()],
  build: {
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
