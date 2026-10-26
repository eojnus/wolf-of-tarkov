import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    port: 5173,
    strictPort: false,
  },
  /**
   * 兼容性目标：本项目是单人本地游戏，不追求最新语法。
   * three 0.186 的源码含 ES2022 类静态块（`static { ... }`），
   * 若开发服务器把依赖按新 baseline 预打包，旧版 Chromium/Edge（如 92）会直接
   * `SyntaxError: Unexpected token '{'`，表现为开始游戏后界面一直停在“正在初始化”。
   * 统一把依赖预打包和生产构建降到 es2019，确保启动链路在旧浏览器也能加载。
   */
  optimizeDeps: {
    rolldownOptions: {
      transform: {
        target: 'es2019',
      },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2019',
    sourcemap: false,
    assetsDir: 'bundle',
  },
});
