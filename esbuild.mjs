import * as esbuild from 'esbuild'
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'fs'

const args = new Set(process.argv.slice(2))
const production = args.has('--production')
const watch = args.has('--watch')

if (production) {
  // Drop source maps left over from development builds.
  rmSync('dist', { recursive: true, force: true })
}
mkdirSync('dist', { recursive: true })
copyFileSync('node_modules/@vscode/codicons/dist/codicon.css', 'dist/codicon.css')
copyFileSync('node_modules/@vscode/codicons/dist/codicon.ttf', 'dist/codicon.ttf')
copyFileSync('media/icon.svg', 'dist/icon.svg')
copyFileSync('media/activity-bar.svg', 'dist/activity-bar.svg')

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
}

const builds = [
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: ['webview/main.tsx'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
  },
]

if (args.has('--tests')) {
  const entryPoints = readdirSync('test')
    .filter(f => f.endsWith('.test.ts'))
    .map(f => `test/${f}`)
  await esbuild.build({
    entryPoints,
    outdir: 'out-test',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
    logLevel: 'warning',
  })
} else if (watch) {
  for (const options of builds) {
    const ctx = await esbuild.context(options)
    await ctx.watch()
  }
} else {
  await Promise.all(builds.map(options => esbuild.build(options)))
}
