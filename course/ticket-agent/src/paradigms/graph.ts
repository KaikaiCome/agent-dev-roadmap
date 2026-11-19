// 第 28 章：Graph 范式的最小运行时（零依赖，约 200 行），按 LangGraph / Pregel 的语义实现：
// - 状态是一个普通对象，节点读状态、返回“要改哪些字段”，不直接修改状态；
// - 执行按“超步”（super-step）推进：同一步里的节点并发运行，读到的是同一份快照，写入在步末统一合并；
// - 同一步里两个节点写同一个字段，必须为它定义 reducer（比如追加），否则报错——并发写冲突在这里被显式化；
// - 每一步结束都存一个检查点；节点可以 interrupt() 暂停整张图，之后 resume(值) 从检查点继续；
// - 恢复时被中断的那一步会整体重跑（节点从头执行），所以 interrupt 之前不能有副作用。
// 和 LangGraph 的差别：它会保存同一步里其他节点已经成功的写入（pending writes），恢复时不重跑它们；这里为了简单整步重跑。

export const START = '__start__';
export const END = '__end__';

export type Reducer<V> = (current: V, update: V) => V;
export type Reducers<S> = { [K in keyof S]?: Reducer<S[K]> };

export interface NodeContext<C> {
  /** 每次 invoke / resume 由调用方传入：身份、依赖等。不进检查点，所以恢复时不会信任存下来的身份 */
  config: C;
  /** 当前是第几个超步 */
  step: number;
  /** 暂停整张图，把 payload 交给外部（比如审批卡片）。恢复时，同一位置的 interrupt() 直接返回 resume 传入的值 */
  interrupt<T = unknown>(payload: unknown): T;
}

export type NodeFn<S, C> = (state: S, context: NodeContext<C>) => Partial<S> | void | Promise<Partial<S> | void>;
export type Router<S> = (state: Readonly<S>) => string | string[];

export interface PendingInterrupt {
  node: string;
  payload: unknown;
  /** 这个节点之前几次 interrupt() 已经拿到的恢复值，按调用顺序排列 */
  resumes: unknown[];
}

export interface Checkpoint<S> {
  id: number;
  threadId: string;
  /** 从哪个检查点走过来的。从旧检查点恢复（时间旅行）会产生分叉 */
  parentId?: number;
  step: number;
  state: S;
  /** 下一步要运行的节点；为空表示这条线程已经走到 END */
  next: string[];
  /** 产生这个检查点的那一步运行了哪些节点 */
  ran: string[];
  interrupt?: PendingInterrupt;
}

export interface GraphCheckpointer<S> {
  put(checkpoint: Omit<Checkpoint<S>, 'id'>): Checkpoint<S>;
  /** 不给 id 时返回这条线程最新的检查点 */
  get(threadId: string, id?: number): Checkpoint<S> | undefined;
  list(threadId: string): Checkpoint<S>[];
}

/** 以 JSON 字符串保存：状态必须可序列化，这是 Graph 范式对状态设计的硬约束 */
export class MemoryGraphCheckpointer<S> implements GraphCheckpointer<S> {
  #threads = new Map<string, string[]>();
  #nextId = 1;

  put(checkpoint: Omit<Checkpoint<S>, 'id'>): Checkpoint<S> {
    const saved = { id: this.#nextId++, ...checkpoint };
    const rows = this.#threads.get(checkpoint.threadId) ?? [];
    rows.push(JSON.stringify(saved));
    this.#threads.set(checkpoint.threadId, rows);
    return JSON.parse(rows.at(-1)!);
  }

  get(threadId: string, id?: number): Checkpoint<S> | undefined {
    const all = this.list(threadId);
    return id === undefined ? all.at(-1) : all.find((checkpoint) => checkpoint.id === id);
  }

  list(threadId: string): Checkpoint<S>[] {
    return (this.#threads.get(threadId) ?? []).map((row) => JSON.parse(row));
  }
}

export class GraphRecursionError extends Error {}
export class InvalidUpdateError extends Error {}

class GraphInterrupt extends Error {
  readonly node: string;
  readonly payload: unknown;
  readonly resumes: unknown[];
  constructor(node: string, payload: unknown, resumes: unknown[]) {
    super(`节点 ${node} 中断`);
    this.node = node;
    this.payload = payload;
    this.resumes = resumes;
  }
}

type Route<S> = { kind: 'edges'; targets: string[] } | { kind: 'router'; router: Router<S>; targets: string[] };

export class StateGraph<S extends object, C = undefined> {
  #initial: () => S;
  #reducers: Reducers<S>;
  #nodes = new Map<string, NodeFn<S, C>>();
  #routes = new Map<string, Route<S>>();

  constructor(options: { initial: () => S; reducers?: Reducers<S> }) {
    this.#initial = options.initial;
    this.#reducers = options.reducers ?? {};
  }

  addNode(name: string, fn: NodeFn<S, C>): this {
    if (name === START || name === END || this.#nodes.has(name)) throw new Error(`节点名 ${name} 不可用`);
    this.#nodes.set(name, fn);
    return this;
  }

  /** 普通边。同一个节点可以有多条普通边：它们指向的节点在下一步并发运行（扇出） */
  addEdge(from: string, to: string): this {
    const route = this.#routes.get(from);
    if (route?.kind === 'router') throw new Error(`${from} 已经有条件边`);
    this.#routes.set(from, { kind: 'edges', targets: [...(route?.targets ?? []), to] });
    return this;
  }

  /** 条件边：运行时由 router 根据最新状态选择去向。targets 列出所有可能的去向，用于校验和画图 */
  addConditionalEdges(from: string, router: Router<S>, targets: string[]): this {
    if (this.#routes.has(from)) throw new Error(`${from} 已经有出边`);
    this.#routes.set(from, { kind: 'router', router, targets });
    return this;
  }

  compile(options: { checkpointer: GraphCheckpointer<S>; recursionLimit?: number }): CompiledGraph<S, C> {
    // 结构错误在编译时暴露，而不是等到某个用户走到那条分支才报错
    if (!this.#routes.has(START)) throw new Error('缺少从 START 出发的边');
    for (const name of this.#nodes.keys()) {
      if (!this.#routes.has(name)) throw new Error(`节点 ${name} 没有出边（走到它之后图不知道去哪；要结束请连到 END）`);
    }
    for (const [from, route] of this.#routes) {
      if (from !== START && !this.#nodes.has(from)) throw new Error(`边的起点 ${from} 不是节点`);
      for (const to of route.targets) if (to !== END && !this.#nodes.has(to)) throw new Error(`${from} → ${to}：目标节点不存在`);
    }
    return new CompiledGraph({
      initial: this.#initial,
      reducers: this.#reducers,
      nodes: new Map(this.#nodes),
      routes: new Map(this.#routes),
      checkpointer: options.checkpointer,
      recursionLimit: options.recursionLimit ?? 25,
    });
  }
}

export interface GraphResult<S> {
  status: 'done' | 'interrupted';
  state: S;
  checkpointId: number;
  interrupt?: { node: string; payload: unknown };
}

interface Compiled<S, C> {
  initial: () => S;
  reducers: Reducers<S>;
  nodes: Map<string, NodeFn<S, C>>;
  routes: Map<string, Route<S>>;
  checkpointer: GraphCheckpointer<S>;
  recursionLimit: number;
}

export class CompiledGraph<S extends object, C = undefined> {
  #g: Compiled<S, C>;

  constructor(compiled: Compiled<S, C>) {
    this.#g = compiled;
  }

  /**
   * input 不为 null：开始新的一轮（同一线程上一轮的状态会保留，input 按 reducer 合并进去）。
   * input 为 null：从最新检查点继续——上一次在某一步抛了异常时，用它重试那一步。
   */
  async invoke(input: Partial<S> | null, options: { threadId: string; config: C }): Promise<GraphResult<S>> {
    const latest = this.#g.checkpointer.get(options.threadId);
    if (latest?.interrupt) throw new Error('线程正在等待 resume');
    if (input === null) {
      if (!latest?.next.length) throw new Error('没有可以继续的步骤');
      return this.#execute(latest, options.config);
    }
    if (latest?.next.length) throw new Error('线程上一轮还没有结束，先用 invoke(null) 重试');
    const state = this.#apply(latest?.state ?? this.#g.initial(), [['__input__', input]]);
    const first = this.#g.checkpointer.put({
      threadId: options.threadId,
      parentId: latest?.id,
      step: (latest?.step ?? -1) + 1,
      state,
      next: this.#successors(START, state),
      ran: [],
    });
    return this.#execute(first, options.config);
  }

  /** 把 value 交给被中断的节点并继续。给 checkpointId 时从那个历史检查点恢复（时间旅行，会产生分叉） */
  async resume(value: unknown, options: { threadId: string; config: C; checkpointId?: number }): Promise<GraphResult<S>> {
    const from = this.#g.checkpointer.get(options.threadId, options.checkpointId);
    if (!from?.interrupt) throw new Error('这个检查点没有等待恢复的中断');
    return this.#execute(from, options.config, [...from.interrupt.resumes, value]);
  }

  getState(threadId: string): Checkpoint<S> | undefined {
    return this.#g.checkpointer.get(threadId);
  }

  getHistory(threadId: string): Checkpoint<S>[] {
    return this.#g.checkpointer.list(threadId);
  }

  /** 生成 Mermaid 流程图：实线是固定边，虚线是条件边 */
  toMermaid(): string {
    const lines = ['flowchart TD'];
    for (const [from, route] of this.#g.routes) {
      for (const to of route.targets) lines.push(`  ${from} ${route.kind === 'router' ? '-.->' : '-->'} ${to}`);
    }
    return lines.join('\n');
  }

  async #execute(start: Checkpoint<S>, config: C, resumes?: unknown[]): Promise<GraphResult<S>> {
    let current = start;
    let resumeFor = resumes ? start.interrupt?.node : undefined;

    for (let steps = 0; current.next.length > 0; steps++) {
      if (steps >= this.#g.recursionLimit) throw new GraphRecursionError(`超过 ${this.#g.recursionLimit} 步仍未到达 END，图里可能有走不出去的环`);
      const snapshot = current;
      const settled = await Promise.allSettled(snapshot.next.map((node) =>
        this.#runNode(node, snapshot, config, node === resumeFor ? resumes! : [])));
      resumeFor = undefined;

      // 任何一个节点失败：这一步的写入全部丢弃，检查点停在上一步，调用方可以 invoke(null) 重试
      const failed = settled.find((r) => r.status === 'rejected' && !(r.reason instanceof GraphInterrupt));
      if (failed?.status === 'rejected') throw failed.reason;

      const interrupts = settled.flatMap((r) => (r.status === 'rejected' ? [r.reason as GraphInterrupt] : []));
      if (interrupts.length > 1) throw new Error('本实现同一步只支持一个中断');
      if (interrupts.length === 1) {
        const [pause] = interrupts;
        const saved = this.#g.checkpointer.put({
          threadId: snapshot.threadId,
          parentId: snapshot.id,
          step: snapshot.step,
          state: snapshot.state,
          next: snapshot.next,
          ran: [],
          interrupt: { node: pause.node, payload: pause.payload, resumes: pause.resumes },
        });
        return { status: 'interrupted', state: saved.state, checkpointId: saved.id, interrupt: { node: pause.node, payload: pause.payload } };
      }

      const updates = settled.map((r, i) => [snapshot.next[i], r.status === 'fulfilled' ? r.value : undefined] as const);
      const state = this.#apply(snapshot.state, updates);
      // 扇入：多个节点指向同一个节点时，它在下一步只运行一次
      const next = [...new Set(snapshot.next.flatMap((node) => this.#successors(node, state)))];
      current = this.#g.checkpointer.put({ threadId: snapshot.threadId, parentId: snapshot.id, step: snapshot.step + 1, state, next, ran: snapshot.next });
    }
    return { status: 'done', state: current.state, checkpointId: current.id };
  }

  async #runNode(name: string, checkpoint: Checkpoint<S>, config: C, resumes: unknown[]): Promise<Partial<S> | void> {
    let calls = 0;
    const context: NodeContext<C> = {
      config,
      step: checkpoint.step,
      interrupt: <T>(payload: unknown): T => {
        const index = calls++;
        if (index < resumes.length) return resumes[index] as T;
        throw new GraphInterrupt(name, payload, resumes);
      },
    };
    // 每个节点拿到自己的一份拷贝：同一步里一个节点改了对象，另一个节点看不到，也不会污染检查点
    return this.#g.nodes.get(name)!(structuredClone(checkpoint.state), context);
  }

  #successors(node: string, state: S): string[] {
    const route = this.#g.routes.get(node)!;
    if (route.kind === 'edges') return route.targets.filter((to) => to !== END);
    const chosen = [route.router(state)].flat();
    for (const to of chosen) if (!route.targets.includes(to)) throw new Error(`${node} 的路由返回了未声明的去向 ${to}`);
    return chosen.filter((to) => to !== END);
  }

  #apply(state: S, updates: ReadonlyArray<readonly [string, Partial<S> | void]>): S {
    const next = { ...state } as Record<string, unknown>;
    const writers = new Map<string, string>();
    const reducers = this.#g.reducers as Record<string, Reducer<unknown> | undefined>;
    for (const [node, update] of updates) {
      if (!update) continue;
      for (const [key, value] of Object.entries(update)) {
        const reducer = reducers[key];
        if (reducer) {
          next[key] = reducer(next[key], value);
          continue;
        }
        const other = writers.get(key);
        if (other) throw new InvalidUpdateError(`${other} 和 ${node} 在同一步都写了 ${key}，需要为它定义 reducer`);
        writers.set(key, node);
        next[key] = value;
      }
    }
    return next as S;
  }
}
