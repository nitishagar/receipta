import { defineConfig } from 'vitepress';

// receipta docs site config. base: '/receipta/' for GitHub Pages project site.
export default defineConfig({
  title: 'receipta',
  description: 'Tamper-evident receipts for every AI decision.',
  base: '/receipta/',
  cleanUrl: true,
  lastUpdated: true,
  head: [
    // Honor both palettes; the restyle targets light + dark (BA-4).
    ['meta', { name: 'color-scheme', content: 'light dark' }],
    // Favicon: relative path under docs/public/ — VitePress serves public/ assets
    // rebased under base "/receipta/" (INV-1). Monochrome SVG, <1KB (BA-7).
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    // theme-color per palette (UA tab/scrollbar tint). light = warm bg, dark = near-black.
    ['meta', { name: 'theme-color', content: '#fcfafa' }],
    ['meta', { name: 'theme-color', content: '#121212', media: '(prefers-color-scheme: dark)' }],
  ],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/quickstart' },
      { text: 'Schema', link: '/schema/' },
      { text: 'CLI', link: '/cli/' },
      { text: 'GitHub', link: 'https://github.com/nitishagar/receipta' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Install', link: '/guide/install' },
          { text: 'Quickstart', link: '/guide/quickstart' },
          { text: 'Concepts', link: '/guide/concepts' },
          { text: 'Threat Model', link: '/guide/threat-model' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Receipt Schema', link: '/schema/' },
          { text: 'CLI', link: '/cli/' },
        ],
      },
      {
        text: 'Adapters',
        items: [
          { text: 'OpenAI', link: '/adapters/openai' },
          { text: 'Anthropic', link: '/adapters/anthropic' },
          { text: 'Vercel AI SDK', link: '/adapters/vercel' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/nitishagar/receipta' }],
    footer: {
      message: 'Released under the Apache-2.0 License.',
      copyright: 'Copyright © 2026 Nitish Agarwal',
    },
  },
});
