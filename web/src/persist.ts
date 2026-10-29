import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 离开界面后，已经输入的东西不能凭空消失。
 *
 * 两种存储，按"值有多大、丢得起与否"分开：
 *  - `useDraft`：文本类（题目、我的答案、日程草稿）→ localStorage，关掉浏览器再打开还在；
 *  - `useKept`：图片类（压缩后的 base64，一张几百 KB～1 MB）→ 只放内存，
 *    切页签不丢，刷新后需要重新上传。不做 localStorage，是怕撑爆 5 MB 配额
 *    后连文本草稿一起写不进去。
 */

const PREFIX = "ai-study.draft.";

function readJson<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw == null) return undefined;
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/**
 * 持久化草稿。
 * 返回 [值, 设置, 清空, 是否为恢复出来的]。
 * 只有用户真的改过才写盘：只是打开页面看一眼，不会留下空草稿。
 */
export function useDraft<T>(
  key: string,
  initial: T,
): [T, (next: T | ((prev: T) => T)) => void, () => void, boolean] {
  const restored = useRef(false);
  const dirty = useRef(false);
  const [value, setValue] = useState<T>(() => {
    const saved = readJson<T>(key);
    if (saved === undefined) return initial;
    restored.current = true;
    return saved;
  });

  useEffect(() => {
    if (!dirty.current) return;
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      // 配额满 / 隐私模式：降级成"仅本次会话有效"，不能因为存不下就把输入卡住
    }
  }, [key, value]);

  const set = useCallback((next: T | ((prev: T) => T)) => {
    dirty.current = true;
    setValue(next);
  }, []);

  const clear = useCallback(() => {
    dirty.current = false;
    // 放弃草稿后，"这是恢复出来的"标记也要一起清掉，
    // 否则用户清空再新建一条时，表单会错误地提示"已恢复上次草稿"
    restored.current = false;
    try {
      localStorage.removeItem(PREFIX + key);
    } catch {
      /* 忽略 */
    }
    setValue(initial);
  }, [key, initial]);

  return [value, set, clear, restored.current];
}

/** 内存级保留：切页签不丢，刷新即失（用于图片这种大对象） */
const keptStore = new Map<string, unknown>();

export function useKept<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const [, force] = useState(0);
  const value = (keptStore.has(key) ? keptStore.get(key) : initial) as T;
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const prev = (keptStore.has(key) ? keptStore.get(key) : initial) as T;
      keptStore.set(key, typeof next === "function" ? (next as (p: T) => T)(prev) : next);
      force((v) => v + 1);
    },
    [key, initial],
  );
  return [value, set];
}
