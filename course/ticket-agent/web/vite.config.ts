import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 开发时把 /api 转发给 Agent 服务。前端和 API 同源，Cookie 和 EventSource 都能正常工作
    proxy: { '/api': 'http://localhost:8787' },
  },
});
