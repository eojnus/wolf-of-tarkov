import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 工具渲染页的独立构建：产物落在 `tools/model-tool/.build/`，
 * 不参与游戏 `vite build`，也不进入安装包。
 *
 * `assetsDir: 'bundle'` 是硬要求：Electron 侧把 `modeltool://app/assets/…`
 * 映射到项目 `public/assets`，构建产物若也叫 assets 会被抢占。
 */
export default defineConfig({
  root: resolve(here, 'renderer'),
  base: './',
  publicDir: false,
  build: {
    outDir: resolve(here, '.build'),
    emptyOutDir: true,
    target: 'es2019',
    sourcemap: false,
    assetsDir: 'bundle',
    rollupOptions: {
      output: {
        entryFileNames: 'bundle/[name].js',
        chunkFileNames: 'bundle/[name].js',
        assetFileNames: 'bundle/[name][extname]',
      },
    },
  },
});
