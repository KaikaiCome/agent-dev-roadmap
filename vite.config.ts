import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { configDefaults } from 'vitest/config'

const ENV_EXAMPLE_ID = 'virtual:course-env-example'

// Vite 默认禁止导入 .env* 文件（防止泄露密钥）。教程只需展示参考项目的 .env.example，
// 因此单独读取这一个文件，而不是放宽 server.fs.deny。
function courseEnvExample(): Plugin {
  const file = fileURLToPath(new URL('./course/ticket-agent/.env.example', import.meta.url))
  return {
    name: 'course-env-example',
    resolveId: (id) => (id === ENV_EXAMPLE_ID ? `\0${ENV_EXAMPLE_ID}` : undefined),
    load(id) {
      if (id !== `\0${ENV_EXAMPLE_ID}`) return undefined
      this.addWatchFile(file)
      return `export default ${JSON.stringify(readFileSync(file, 'utf8'))}`
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  // Relative asset paths so the built site works from any static host or subpath.
  base: './',
  plugins: [react(), courseEnvExample()],
  test: {
    environment: 'jsdom',
    // Node 25+ ships a global localStorage that shadows jsdom's implementation.
    execArgv: ['--no-experimental-webstorage'],
    // 参考项目后端和 MCP 服务的测试用 node:test 编写，由 npm run test:course / test:mcp 运行
    exclude: [...configDefaults.exclude, 'course/ticket-agent/test/**', 'course/ticket-agent/mcp/test/**'],
  },
})
