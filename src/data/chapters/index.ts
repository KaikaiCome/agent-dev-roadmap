import type { Chapter } from '../tutorial';
import { chapter as subagentsMemory } from './subagents-memory';
import { chapter as codingAgent } from './coding-agent';
import { chapter as redTeam } from './red-team';
import { chapter as observability } from './observability';
import { chapter as distributed } from './distributed';
import { chapter as realModel } from './real-model';
import { chapter as modelSide } from './model-side';
import { chapter as frameworks } from './frameworks';
import { chapter as pythonPort } from './python-port';

// 第 19 章起的落地章节，每章一个文件，按章节号顺序排列。
export const implementationChapters: Chapter[] = [subagentsMemory, codingAgent, redTeam, observability, distributed, realModel, modelSide, frameworks, pythonPort];
