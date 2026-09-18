import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  /**
   * A GitHub Pages project site is served from `/<repo>/`, not from the root,
   * and a bundle built for `/` asks for its assets at the wrong path there —
   * a white page with two 404s and nothing in the console to explain it.
   * `BASE_PATH` is set by `.github/workflows/pages.yml`; locally and on any
   * host that serves the root, it is absent and this is `/`.
   */
  base: process.env.BASE_PATH ?? '/',
})
