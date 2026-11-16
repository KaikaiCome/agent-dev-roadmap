import envExample from 'virtual:course-env-example';

// 把参考项目的源码以原始文本导入，教程里展示的代码与可运行、已测试的代码永远一致。
const modules = import.meta.glob(
  [
    '../../course/ticket-agent/**/*.{ts,tsx,json,html}',
    '../../course/ticket-agent/Dockerfile',
    '!**/node_modules/**',
    '!**/package-lock.json',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

const PREFIX = '../../course/ticket-agent/';

/** key 是相对 course/ticket-agent 的路径，例如 src/agent.ts */
export const courseFiles: Record<string, string> = {
  ...Object.fromEntries(Object.entries(modules).map(([path, source]) => [path.slice(PREFIX.length), source])),
  '.env.example': envExample,
};

export const COURSE_REPO_URL = 'https://github.com/KaikaiCome/agent-dev-roadmap/tree/main/course/ticket-agent';
