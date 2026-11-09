import { defineConfig, type Plugin } from 'vite';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// 嵌进 Hikos 时 base 必须是 /arcade/tower-defense/（宿主 nginx `location ^~ /arcade/`，接入说明 §4.1）：
//   VITE_BASE=/arcade/tower-defense/ npm run build
// 独立托管仍是 '/'（缺省）。

/** 构建信息写进 dist/BUILD.json：宿主仓 web/scripts/sync-arcade.sh 读它填 SOURCE.json 的 game_version / game_commit / built_at。 */
function buildInfo(): Plugin {
  let outDir = 'dist';
  return {
    name: 'td-build-info',
    apply: 'build',
    configResolved(c) { outDir = c.build.outDir; },
    closeBundle() {
      const require = createRequire(import.meta.url);
      const { version } = require('./package.json') as { version: string };
      let commit: string | null = process.env.BUILD_COMMIT ?? null;
      if (!commit) { try { commit = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { commit = null; } }
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'BUILD.json'), JSON.stringify({ version, commit, built_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), base: process.env.VITE_BASE ?? '/' }, null, 2) + '\n');
    },
  };
}

// 宿主用 sandbox="allow-scripts"（不透明源）嵌入，模块脚本是 CORS 请求：线上 nginx `/arcade/` 回 Access-Control-Allow-Origin: *（接入说明 §1.4 / §4.1），
// 本地 dev / preview 也回同样的头，否则嵌入联调（tests/e2e/hikos-embed.spec.ts）里脚本会被浏览器拦下。
const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*' };

export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  build: {
    target: 'esnext'
  },
  server: { headers: CORS_HEADERS },
  preview: { headers: CORS_HEADERS },
  plugins: [buildInfo()]
});
