import type { ModuleOptions } from '@nuxtjs/tailwindcss'

/**
 * Apple 设计令牌到 Tailwind 工具类的映射（架构文档 §16.1）。
 *
 * 令牌本身定义在 `assets/css/tokens.css`，这里只做「变量 → 工具类」的转接：
 * 颜色、圆角、字号、动效曲线全部引用 CSS 变量，深浅两套外观只换变量值，
 * 组件不需要写 `dark:` 变体。
 */
type TailwindConfig = NonNullable<ModuleOptions['config']>

const tailwindConfig: TailwindConfig = {
  theme: {
    extend: {
      colors: {
        bg: { DEFAULT: 'var(--bg)', 2: 'var(--bg-2)' },
        surface: {
          DEFAULT: 'var(--surface)',
          2: 'var(--surface-2)',
          3: 'var(--surface-3)',
          4: 'var(--surface-4)',
        },
        label: {
          DEFAULT: 'var(--label)',
          2: 'var(--label-2)',
          3: 'var(--label-3)',
          4: 'var(--label-4)',
        },
        separator: 'var(--separator)',
        hairline: { DEFAULT: 'var(--hairline)', strong: 'var(--hairline-strong)' },
        fill: {
          hover: 'var(--fill-hover)',
          press: 'var(--fill-press)',
          2: 'var(--fill-2)',
          3: 'var(--fill-3)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          ink: 'var(--accent-ink)',
          fill: 'var(--accent-fill)',
          tint: 'var(--accent-tint)',
        },
        red: { DEFAULT: 'var(--red)', ink: 'var(--red-ink)', fill: 'var(--red-fill)', tint: 'var(--red-tint)' },
        green: { DEFAULT: 'var(--green)', ink: 'var(--green-ink)', fill: 'var(--green-fill)', tint: 'var(--green-tint)' },
        orange: { DEFAULT: 'var(--orange)', ink: 'var(--orange-ink)', fill: 'var(--orange-fill)', tint: 'var(--orange-tint)' },
        purple: { DEFAULT: 'var(--purple)', ink: 'var(--purple-ink)', tint: 'var(--purple-tint)' },
        teal: { DEFAULT: 'var(--teal)', ink: 'var(--teal-ink)', tint: 'var(--teal-tint)' },
        yellow: { DEFAULT: 'var(--yellow)', ink: 'var(--yellow-ink)', tint: 'var(--yellow-tint)' },
        gray: { DEFAULT: 'var(--gray)', ink: 'var(--gray-ink)', tint: 'var(--gray-tint)' },
      },
      fontFamily: {
        sans: ['var(--font)'],
        mono: ['var(--mono)'],
      },
      fontSize: {
        display: ['34px', { lineHeight: '1.1', letterSpacing: '-0.024em', fontWeight: '700' }],
        'title-xl': ['28px', { lineHeight: '1.16', letterSpacing: '-0.021em', fontWeight: '700' }],
        title: ['22px', { lineHeight: '1.24', letterSpacing: '-0.018em', fontWeight: '600' }],
        headline: ['17px', { lineHeight: '1.35', letterSpacing: '-0.011em', fontWeight: '590' }],
        body: ['15px', { lineHeight: '1.47', letterSpacing: '-0.006em' }],
        'body-sm': ['14px', { lineHeight: '1.47' }],
        caption: ['13px', { lineHeight: '1.4' }],
      },
      spacing: {
        's-1': 'var(--s-1)',
        's-2': 'var(--s-2)',
        's-3': 'var(--s-3)',
        's-4': 'var(--s-4)',
        's-5': 'var(--s-5)',
        's-6': 'var(--s-6)',
        's-7': 'var(--s-7)',
        's-8': 'var(--s-8)',
        's-9': 'var(--s-9)',
      },
      borderRadius: {
        xs: 'var(--r-xs)',
        sm: 'var(--r-sm)',
        control: 'var(--r-control)',
        card: 'var(--r-card)',
        panel: 'var(--r-panel)',
        sheet: 'var(--r-sheet)',
        pill: 'var(--r-pill)',
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        pop: 'var(--shadow-pop)',
        sheet: 'var(--shadow-sheet)',
        hair: 'var(--inset-hair)',
        top: 'var(--inset-top)',
      },
      transitionTimingFunction: {
        apple: 'var(--ease)',
        'apple-out': 'var(--ease-out)',
      },
      transitionDuration: {
        fast: '160ms',
        base: '280ms',
        slow: '420ms',
      },
      width: {
        sidebar: 'var(--sidebar-w)',
      },
      maxWidth: {
        prose: '68ch',
      },
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
