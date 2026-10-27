async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const j = JSON.parse(text) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      msg = text.slice(0, 200) || msg;
    }
    throw new Error(msg);
  }
  return JSON.parse(text) as T;
}

export const api = {
  week: (week?: number) =>
    req<import("./types.ts").WeekResponse>(`/api/week${week == null ? "" : `?week=${week}`}`),

  plan: (week: number, perDayMinutes: number) =>
    req<import("./types.ts").PlanResponse>("/api/plan", {
      method: "POST",
      body: JSON.stringify({ week, perDayMinutes }),
    }),

  ask: (question: string) =>
    req<import("./types.ts").AskResponse>("/api/ask", {
      method: "POST",
      body: JSON.stringify({ question }),
    }),

  review: (question: string, myAnswer: string, correctAnswer?: string) =>
    req<import("./types.ts").ReviewResponse>("/api/review", {
      method: "POST",
      body: JSON.stringify({ question, myAnswer, correctAnswer }),
    }),

  mistakes: () =>
    req<{
      ok: boolean;
      mistakes: import("./types.ts").Mistake[];
      stats: import("./types.ts").MistakeStats;
    }>("/api/mistakes"),

  saveMistake: (body: {
    title: string;
    raw_text?: string;
    my_answer?: string;
    correct_answer?: string;
    error_type?: string;
    error_detail?: string;
    kp_codes?: string[];
  }) =>
    req<{ ok: boolean; id: number }>("/api/mistakes", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  deleteMistake: (id: number) => req<{ ok: boolean }>(`/api/mistakes/${id}`, { method: "DELETE" }),

  attempt: (id: number, correct: boolean) =>
    req<{ ok: boolean; attempts: number; resolved: boolean }>(`/api/mistakes/${id}/attempt`, {
      method: "POST",
      body: JSON.stringify({ correct }),
    }),
};
