import type { ModuleOptions } from '@nuxtjs/tailwindcss'

/**
 * preflight 里 `:host,html` 与 `code,kbd,pre,samp` 的字体栈从 `theme.fontFamily` 取。
 * 字体变量本身定义在 `assets/css/tokens.css`（`--font` / `--mono`）。
 */
type TailwindConfig = NonNullable<ModuleOptions['config']>

const tailwindConfig: TailwindConfig = {
  theme: {
    extend: {
      fontFamily: { sans: ['var(--font)'], mono: ['var(--mono)'] },
    },
  },
}

export default defineNuxtConfig({
  // 内部管理工具，不需要 SEO；关掉 SSR 让 API 读取只跑在浏览器，
  // 开发时由 nitro 的 devProxy 把 /api 转到后端，免去 CORS 配置。
  ssr: false,
  devtools: { enabled: false },

  modules: ['@nuxtjs/tailwindcss'],
  css: ['~/assets/css/tokens.css', '~/assets/css/main.css'],
  // 模板里没有工具类，但 preflight（base 层）由这个模块注入，删模块会全局变样。
  tailwindcss: { config: tailwindConfig, viewer: false },

  runtimeConfig: {
    public: {
      apiBase: '/api/v1',
    },
  },

  nitro: {
    devProxy: {
      // 端口必须跟后端一致，否则控制台把请求转给别的服务，而界面看起来「有数据」。
      // 后端用 `COMEM_SERVER_PORT` 改端口时这里跟着变（`scripts/dev.sh` 会传）。
      '/api': {
        target: `http://127.0.0.1:${process.env['COMEM_SERVER_PORT'] ?? '1933'}/api`,
        changeOrigin: true,
      },
    },
  },

  app: {
    head: {
      title: 'CoMem 控制台',
      htmlAttrs: { lang: 'zh-CN', 'data-theme': 'dark' },
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      ],
    },
  },

  typescript: {
    strict: true,
  },
})
