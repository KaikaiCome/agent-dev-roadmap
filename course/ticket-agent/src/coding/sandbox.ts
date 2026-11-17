import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// 第 20 章：在工作区里运行命令。三道限制：命令白名单（见 tools.ts）、资源限制（超时、输出长度）、隔离（权限模型或容器）。
//
// 重要：Node 的权限模型（--permission）不是安全边界。官方文档明确说它防的是“可信代码的意外行为”，
// 不防恶意代码：原生插件、已打开的文件描述符、符号链接、运行时漏洞都可能绕过它。
// 运行来路不明的代码（Agent 改过的代码就属于这种）要用容器或虚拟机，见 dockerArgv。

export type SandboxRunner = 'node-permission' | 'docker';

export interface RunLimits {
  timeoutMs: number;
  /** 回传给模型的输出最多多少字符。超出时保留开头 30% 和结尾 70%（测试失败的汇总通常在结尾） */
  maxOutputChars: number;
}

export const defaultLimits: RunLimits = { timeoutMs: 20_000, maxOutputChars: 4_000 };

export interface ProcessResult {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  outputTruncated: boolean;
  durationMs: number;
  pid?: number;
}

/** 子进程只继承运行所需的最少环境变量：API key、云凭据、NODE_OPTIONS 一律不传 */
const inheritedEnv = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'LANG', 'TZ']);

export function scrubbedEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && inheritedEnv.has(key.toUpperCase())) env[key] = value;
  }
  return { ...env, NO_COLOR: '1', CI: '1' };
}

/** 用 Node 权限模型运行：只能读写工作区；不能起子进程、开 worker、联网（Node 25 起 --allow-net 未给出即禁止） */
export function nodePermissionArgv(root: string, nodeArgs: string[]): string[] {
  return [process.execPath, '--permission', `--allow-fs-read=${root}`, `--allow-fs-write=${root}`, ...nodeArgs];
}

export const dockerImage = 'node:24-slim';

/** 容器方案：没有网络、根文件系统只读、限制内存/CPU/进程数、非 root、去掉全部 capability，只把工作区挂进去 */
export function dockerArgv(root: string, nodeArgs: string[], name = `coding-agent-${randomUUID().slice(0, 8)}`): string[] {
  return [
    'docker', 'run', '--rm', '--name', name,
    '--network', 'none',
    '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '--memory', '512m', '--memory-swap', '512m', '--cpus', '1', '--pids-limit', '128',
    '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--mount', `type=bind,src=${root},dst=/workspace`, '-w', '/workspace',
    '-e', 'NO_COLOR=1', '-e', 'CI=1',
    dockerImage, 'node', ...nodeArgs,
  ];
}

/** 结束整个进程树。只杀直接子进程不够：测试框架、npm、shell 都会再起孙进程，它们会继续占用 CPU 和端口 */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    // detached: true 让子进程成为新进程组的组长，-pid 表示整个进程组
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

export interface RunProcessOptions extends RunLimits {
  cwd: string;
  env: Record<string, string>;
  signal?: AbortSignal;
  /** 超时或取消时额外执行的清理。docker 方案里杀掉 docker CLI 不会停止容器，要另外 docker kill */
  onKill?: () => void;
}

export function runProcess(argv: string[], options: RunProcessOptions): Promise<ProcessResult> {
  const started = Date.now();
  const headCap = Math.floor(options.maxOutputChars * 0.3);
  const tailCap = options.maxOutputChars - headCap;
  let head = '';
  let tail = '';
  let total = 0;
  const collect = (chunk: string) => {
    total += chunk.length;
    if (head.length < headCap) {
      const take = chunk.slice(0, headCap - head.length);
      head += take;
      chunk = chunk.slice(take.length);
    }
    // 只保留结尾的一段：输出再多，内存占用也有上限
    if (chunk) tail = (tail + chunk).slice(-tailCap);
  };

  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8').on('data', collect);
    child.stderr.setEncoding('utf8').on('data', collect);

    let timedOut = false;
    let settled = false;
    const stop = () => {
      options.onKill?.();
      killTree(child);
      // 孙进程占着管道时 close 事件可能迟迟不来，兜底 2 秒后直接返回
      setTimeout(() => finish(null), 2_000).unref();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
    const onAbort = () => stop();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const omitted = total - head.length - tail.length;
      resolve({
        exitCode: timedOut ? null : exitCode,
        timedOut,
        output: omitted > 0 ? `${head}\n…（省略 ${omitted} 个字符）…\n${tail}` : head + tail,
        outputTruncated: omitted > 0,
        durationMs: Date.now() - started,
        pid: child.pid,
      });
    };
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => finish(code));
  });
}
