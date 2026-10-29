import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from "react";

/**
 * 后台任务登记表。
 *
 * 目的：切到别的标签页时，正在跑的解题请求不能断、结果不能丢。
 * 做法是把「谁在跑、跑到哪一步、结果是什么」放到 React 树之外（Provider 里），
 * 标签页卸载只销毁界面，不销毁 Promise 与结果。
 */
export type JobStatus = "running" | "done" | "error";

export interface JobState<T = unknown> {
  id: string;
  label: string;
  status: JobStatus;
  startedAt: number;
  finishedAt?: number;
  result?: T;
  error?: string;
}

interface JobsApi {
  /** 当前所有任务，按开始时间倒序 */
  jobs: JobState[];
  running: number;
  /**
   * 启动一个后台任务；重复 id 会覆盖上一个。
   * fn 拿到的 patch 可以在跑的过程中不断更新进度（流式正文靠它）。
   */
  run: (
    id: string,
    label: string,
    fn: (patch: (p: Partial<JobState>) => void) => Promise<unknown>,
  ) => void;
  /** 读某个任务的状态（组件重新渲染时拿到最新值） */
  get: <T>(id: string) => JobState<T> | undefined;
  /** 直接把一个已完成的结果放进来（刷新后从本地库恢复时用） */
  restore: (id: string, label: string, result: unknown) => void;
  clear: (id: string) => void;
}

const JobsCtx = createContext<JobsApi | null>(null);

export function JobsProvider({ children }: { children: ReactNode }) {
  const store = useRef(new Map<string, JobState>());
  // 用自增版本号驱动重渲染：Map 是可变对象，改它不会触发 React 更新
  const [, bump] = useState(0);
  const refresh = useCallback(() => bump((v) => v + 1), []);

  const run = useCallback(
    (
      id: string,
      label: string,
      fn: (patch: (p: Partial<JobState>) => void) => Promise<unknown>,
    ) => {
      store.current.set(id, { id, label, status: "running", startedAt: Date.now() });
      refresh();

      // 流式正文靠这个把「已收到的部分」持续写进任务表
      const patch = (p: Partial<JobState>): void => {
        const cur = store.current.get(id);
        if (!cur) return;
        store.current.set(id, { ...cur, ...p });
        refresh();
      };

      // 故意不 await：调用方组件卸载与否，都不影响这个链路跑完
      fn(patch).then(
        (result) => {
          const cur = store.current.get(id);
          store.current.set(id, {
            id,
            label,
            status: "done",
            startedAt: cur?.startedAt ?? Date.now(),
            finishedAt: Date.now(),
            result,
          });
          refresh();
        },
        (e: Error) => {
          const cur = store.current.get(id);
          store.current.set(id, {
            id,
            label,
            status: "error",
            startedAt: cur?.startedAt ?? Date.now(),
            finishedAt: Date.now(),
            error: e.message,
          });
          refresh();
        },
      );
    },
    [refresh],
  );

  const restore = useCallback(
    (id: string, label: string, result: unknown) => {
      store.current.set(id, {
        id,
        label,
        status: "done",
        startedAt: Date.now(),
        finishedAt: Date.now(),
        result,
      });
      refresh();
    },
    [refresh],
  );

  const clear = useCallback(
    (id: string) => {
      store.current.delete(id);
      refresh();
    },
    [refresh],
  );

  // Provider 只会在任务状态变化时重渲染，这里不必再 memo：
  // 每次重渲染本来就该让消费者拿到最新的任务列表。
  const list = [...store.current.values()].sort((a, b) => b.startedAt - a.startedAt);
  const api: JobsApi = {
    jobs: list,
    running: list.filter((j) => j.status === "running").length,
    run,
    get: <T,>(id: string) => store.current.get(id) as JobState<T> | undefined,
    restore,
    clear,
  };

  return <JobsCtx.Provider value={api}>{children}</JobsCtx.Provider>;
}

export function useJobs(): JobsApi {
  const ctx = useContext(JobsCtx);
  if (!ctx) throw new Error("useJobs 必须在 JobsProvider 内使用");
  return ctx;
}
