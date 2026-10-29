import { useState } from "react";
import { api } from "../api.ts";
import type { CourseMatch, TimetableRow } from "../types.ts";

/**
 * 首次设置：上传课表 → 识别成日程 + 建科目/空库。
 *
 * 模型只负责"哪门课、周几、几节、叫什么"和"课表名对应哪个课程代码"；
 * 时间合法性、去重、写库全在服务端代码里（/api/timetable/*）。
 */
export default function Setup({ onDone, onClose }: { onDone: () => void; onClose?: () => void }) {
  const [text, setText] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [imageName, setImageName] = useState("");
  const [rows, setRows] = useState<TimetableRow[] | null>(null);
  const [matches, setMatches] = useState<CourseMatch[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [applied, setApplied] = useState<{
    scheduleAdded: number;
    subjects: Array<{ code: string; name: string; dbCreated: boolean; textbookReady: boolean }>;
    unmatched: string[];
  } | null>(null);

  const pickImage = async (file: File | null): Promise<void> => {
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) {
      setErr("图片太大（>12MB），请压缩后再传");
      return;
    }
    const data = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error("读取图片失败"));
      r.readAsDataURL(file);
    });
    setImage(data);
    setImageName(file.name);
    setErr(null);
  };

  const parse = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    setApplied(null);
    try {
      const r = await api.parseTimetable({
        text: text.trim() || undefined,
        image: image ?? undefined,
      });
      setRows(r.rows);
      if (r.rows.length === 0) {
        setErr("没有识别出课程行：确认图片清晰，或直接把课表文字粘进来");
        return;
      }
      const m = await api.matchTimetable([...new Set(r.rows.map((x) => x.title))]);
      setMatches(m.matches);
      setMsg(`识别到 ${r.rows.length} 节课；课程代码由 qwen 判断，请核对后导入`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const apply = async (): Promise<void> => {
    if (!rows || rows.length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      // 模型猜的对应（needsConfirm）不自动采用：只提交可直接用的
      const usable = matches.filter((m) => m.code && !m.needsConfirm);
      const r = await api.applyTimetable({ rows, matches: usable });
      setApplied(r);
      setMsg(
        `已导入 ${r.scheduleAdded} 节日程、${r.subjects.length} 门课程（新建库 ${r.subjects.filter((s) => s.dbCreated).length} 个空库）`,
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="setupoverlay">
      <section className="panel setupbox">
        <div className="row between">
          <h2>首次设置：导入课表</h2>
          {onClose && (
            <button type="button" className="link" onClick={onClose}>
              稍后再说
            </button>
          )}
        </div>
        <p className="hint">
          上传教务系统课表截图，或把课表文字粘进来。识别后我会：
          <b>写进日程表</b> → <b>按课程名判断课程代码</b>（由 qwen 判断，可核对）→{" "}
          <b>登记科目并建空库</b>。教材/课件不会凭空产生，之后放进{" "}
          <code>课程/&lt;课程简称&gt;/</code> 再建库。
        </p>

        <label className="fld">
          <span>课表图片（截图即可，模型会先转录再解析）</span>
          <input
            type="file"
            accept="image/*"
            onChange={(e) => void pickImage(e.target.files?.[0] ?? null)}
          />
          {imageName && <span className="meta">已选择：{imageName}</span>}
        </label>

        <label className="fld">
          <span>或粘贴课表文字</span>
          <textarea
            rows={6}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              "周一 1-2节 大学物理(B)II 教四-202\n周二 3-5节 概率统计与随机过程 教六-101 ……"
            }
          />
        </label>

        <div className="row">
          <button
            type="button"
            className="primary"
            onClick={() => void parse()}
            disabled={busy || (!text.trim() && !image)}
          >
            {busy ? "识别中…" : "识别课表"}
          </button>
          {rows && rows.length > 0 && (
            <button type="button" onClick={() => void apply()} disabled={busy}>
              {busy ? "导入中…" : "确认导入"}
            </button>
          )}
          {rows && (
            <button
              type="button"
              onClick={() => {
                setRows(null);
                setMatches([]);
                setApplied(null);
              }}
              disabled={busy}
            >
              重新识别
            </button>
          )}
        </div>

        {msg && <div className="alert okbox">{msg}</div>}
        {err && <div className="alert errbox">{err}</div>}

        {rows && rows.length > 0 && (
          <div className="setuptable">
            <table>
              <thead>
                <tr>
                  <th>课程</th>
                  <th>代码（qwen 判断）</th>
                  <th>周几</th>
                  <th>时间</th>
                  <th>地点</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const m = matches.find((x) => x.title === r.title);
                  return (
                    <tr key={`${r.title}-${r.weekday}-${r.start}-${i}`}>
                      <td>{r.title}</td>
                      <td>
                        {m?.code ? (
                          <span className="tag subj" title={m.reason}>
                            {m.code}
                          </span>
                        ) : (
                          <span className="tag" title={m?.reason}>
                            待指定
                          </span>
                        )}
                      </td>
                      <td>周{"一二三四五六日"[r.weekday - 1]}</td>
                      <td>
                        {r.start}–{r.end}
                      </td>
                      <td>{r.location ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="hint">
              「待指定」的课仍会写进日程，但暂时没有课程记忆锚点：去「科目」页手动添加即可。
            </p>
          </div>
        )}

        {applied && (
          <div className="alert okbox">
            <p>
              已写 {applied.scheduleAdded} 节日程，登记 {applied.subjects.length} 门课：
              {applied.subjects.map((s) => `${s.name}（${s.code}）`).join("、")}
            </p>
            {applied.unmatched.length > 0 && (
              <p className="meta">未匹配到代码：{applied.unmatched.join("、")}</p>
            )}
            <button type="button" className="primary" onClick={onDone}>
              进入应用
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
