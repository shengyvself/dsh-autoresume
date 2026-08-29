// 构建 dsh-autoresume：服务端 ESM 原样复制；客户端为无界面占位，
// 用与 narrative-studio-roundtable 相同的 window.__ModuleLoader__ CJS 包装（ALTM 同构）。
import { rm, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
await rm(new URL('../lib', import.meta.url), { recursive: true, force: true });
await mkdir(new URL('../lib', import.meta.url), { recursive: true });
await cp(new URL('../src/service.js', import.meta.url), new URL('../lib/service.js', import.meta.url));

const clientId = 'dsh-autoresume';
const clientSource = await readFile(new URL('../src/client.js', import.meta.url), 'utf8');
const body = clientSource
  .replace("export const name = 'dsh-autoresume/client';", "const name = 'dsh-autoresume/client';")
  .replace('export function apply', 'function apply')
  .trimEnd() + '\nmodule.exports = { name, apply };\n';
const banner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(clientId)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`;
const footer = 'return module.exports; } });';
await writeFile(new URL('../lib/client.js', import.meta.url), `${banner}\n${body}\n${footer}\n`);

console.log('built dsh-autoresume');
