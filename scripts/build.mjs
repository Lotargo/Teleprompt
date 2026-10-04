import { build } from 'esbuild';

// Bundle dependencies so a plugin cache only needs Node, not node_modules.
await build({
  entryPoints: ['cli.ts'], outfile: 'dist/cli.js', bundle: true, platform: 'node', format: 'esm',
  target: 'node22', sourcemap: true,
  banner: { js: "import { createRequire as telepromptCreateRequire } from 'node:module'; const require = telepromptCreateRequire(import.meta.url);" }
});
