import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      sourcemap: true,
      rollupOptions: {
        input: resolve('src/main/index.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      sourcemap: true,
      rollupOptions: {
        input: resolve('src/preload/index.ts'),
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    build: {
      sourcemap: true,
      rollupOptions: {
        input: {
          shell: resolve('src/renderer/shell/index.html'),
          service: resolve('src/renderer/service/index.html'),
          alert: resolve('src/renderer/alert/index.html'),
          settings: resolve('src/renderer/settings/index.html')
        }
      }
    }
  }
})
