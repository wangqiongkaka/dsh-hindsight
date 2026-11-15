import { build } from 'esbuild';
import { mkdir, copyFile, rm } from 'node:fs/promises';

await rm('lib', { recursive: true, force: true });
await mkdir('lib', { recursive: true });
await mkdir('lib/licenses', { recursive: true });
for (const name of ['ajv', 'fast-deep-equal', 'fast-uri', 'json-schema-traverse', 'require-from-string']) {
  await copyFile(`node_modules/${name}/LICENSE`, `lib/licenses/${name}.txt`);
}
await build({ entryPoints: ['src/index.mjs'], outfile: 'lib/index.js', bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['@deepseek-ai/*'], sourcemap: true });
await build({ entryPoints: ['src/client.jsx'], outfile: 'lib/client.js', bundle: true, platform: 'browser', format: 'cjs', target: 'es2022', jsx: 'automatic',
  loader: { '.css': 'text' },
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-hindsight",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: 'return module.exports;}});' }, sourcemap: true });
