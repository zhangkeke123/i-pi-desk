import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const root = fileURLToPath(new URL('.', import.meta.url))

/**
 * `@i-pi-desk/shared` 是纯 TS 的契约包（只有类型和常量），刻意**内联进产物**
 * 而不是 externalize：它自己是 ESM-only，若被 CJS 的 preload 用 require 加载，
 * 就会踩到 ERR_REQUIRE_ESM。内联掉它，这类打包期的解析问题一次性消失。
 */
const inlineShared = { exclude: ['@i-pi-desk/shared'] }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(inlineShared)],
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'electron/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin(inlineShared)],
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'electron/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(root, 'src'),
    resolve: {
      alias: {
        '@': resolve(root, 'src')
      }
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'src/index.html') }
      }
    }
  }
})
