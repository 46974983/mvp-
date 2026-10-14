import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  server: {
    port: 5173,
    strictPort: true,
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,

    /**
     * 拆包策略
     * ------------------------------------------------------------------------
     * 桌面版的资源是从本地磁盘读的，所以这里拆包**不是**为了少传几个字节，
     * 而是为了两件事：
     *   1. 首屏只需要解析聊天界面用得到的代码，设置页的表单库按需加载；
     *   2. 依赖和应用代码分开，看构建报告时能一眼分清「谁的体积」。
     *
     * 只固定 react 和 UI 两个组，**不设「其余 node_modules 全进 vendor」的兜底组**。
     * 兜底组看起来整齐，实际上会把「只有设置页才用的库」也钉进首屏 chunk，
     * 正好抵消掉按需加载的收益 —— 谁被谁用到，交给打包器按实际引用关系决定。
     *
     * Vite 8 用 rolldown，`codeSplitting.groups` 是它现在的写法
     * （旧的 `advancedChunks` / `manualChunks` 已被标记废弃）。
     */
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'vendor-react',
              test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
            },
            {
              name: 'vendor-ui',
              test: /node_modules[\\/](@radix-ui|sonner|lucide-react)[\\/]/,
            },
          ],
        },
      },
    },
  },

  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    setupFiles: ['./tests/unit/setup.ts'],
    restoreMocks: true,
  },
});
