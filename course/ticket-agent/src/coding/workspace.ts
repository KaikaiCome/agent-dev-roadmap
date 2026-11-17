import { cp, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ToolError } from '../tools/types.ts';

// 第 20 章：编码 Agent 的所有文件操作都限制在一个工作区目录里。
// 模型给出的路径一律当作不可信输入：只接受工作区内的相对路径，并用 realpath 再检查一次，防止符号链接把操作带到外面。

/** 工作区内永远不让 Agent 看到或修改的目录（版本库元数据、依赖） */
export const hiddenEntries = new Set(['.git', 'node_modules']);

export interface Workspace {
  /** 工作区根目录的真实路径（已解析符号链接） */
  root: string;
}

export async function openWorkspace(dir: string): Promise<Workspace> {
  return { root: await realpath(dir) };
}

/**
 * 把模型给出的相对路径解析成工作区内的真实路径。
 * 拒绝：绝对路径、盘符、含 `..` 的路径、隐藏目录、不存在的文件、解析符号链接后落在工作区外的路径。
 */
export async function resolveInside(workspace: Workspace, input: string): Promise<{ absolute: string; relative: string }> {
  if (input.includes('\0')) throw new ToolError('PATH_REJECTED', '路径包含非法字符');
  const normalized = input.replaceAll('\\', '/').trim();
  if (normalized === '' || normalized === '.') return { absolute: workspace.root, relative: '.' };
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || path.isAbsolute(input)) {
    throw new ToolError('PATH_REJECTED', `只接受工作区内的相对路径，收到绝对路径：${input}`);
  }
  const segments = normalized.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.includes('..')) throw new ToolError('PATH_REJECTED', `路径不能包含 ..：${input}`);
  const hidden = segments.find((s) => hiddenEntries.has(s));
  if (hidden) throw new ToolError('PATH_REJECTED', `不允许访问 ${hidden}`);

  const relative = segments.join('/');
  let real: string;
  try {
    real = await realpath(path.join(workspace.root, ...segments));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ToolError('NOT_FOUND', `文件不存在：${relative}`);
    throw error;
  }
  // 字符串检查挡不住符号链接：ws/link -> /etc 在字面上完全“在工作区内”
  if (!isWithin(workspace.root, real)) {
    throw new ToolError('PATH_REJECTED', `${relative} 解析后位于工作区之外（符号链接？）`);
  }
  return { absolute: real, relative };
}

export function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * 把模板项目复制到一个一次性的临时目录。Agent 在副本上随便改，原目录（这里是仓库里的 fixture）保持干净；
 * 用完调用 dispose 删除。“自动模式”只在这种可丢弃的副本上才说得过去。
 */
export async function disposableCopy(source: string): Promise<{ dir: string; dispose: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'coding-agent-'));
  await cp(source, dir, { recursive: true, filter: (src) => !hiddenEntries.has(path.basename(src)) });
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) };
}
