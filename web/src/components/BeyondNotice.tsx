export interface BeyondItem {
  topic: string;
  chapter_no: number | null;
  why: string;
}

/**
 * 越界提醒。
 *
 * 设计立场：这不是警告，是**给学生的免责说明**。
 * 学生看到"用了泰勒公式"时的真实心理是"我是不是太差了"，
 * 所以文案必须先说清"这不是你的问题，是进度还没到"。
 *
 * 两档：
 *  - beyond：章节定位到了、确实没学 → 明确说明
 *  - uncertain：模型觉得越界但定位不到章节 → 只说"可能"，不吓人也不错杀
 */
export default function BeyondNotice({
  beyond,
  uncertain,
  maxChapterNo,
}: {
  beyond?: BeyondItem[];
  uncertain?: BeyondItem[];
  maxChapterNo?: number | null;
}) {
  const sure = beyond ?? [];
  const maybe = (uncertain ?? []).filter((u) => !sure.some((b) => b.topic === u.topic));
  if (sure.length === 0 && maybe.length === 0) return null;

  const chapters = [
    ...new Set(sure.map((b) => b.chapter_no).filter((n): n is number => n != null)),
  ].sort((a, b) => a - b);
  const topics = sure.map((b) => b.topic).filter(Boolean);

  return (
    <>
      {sure.length > 0 && (
        <div className="beyond">
          <div className="bt">
            ⚠ 这道题用到了你还没学的
            {chapters.length > 0 ? `第 ${chapters.join("、")} 章` : "内容"}
          </div>
          <div className="bl">
            涉及：{topics.join("、")}
            {maxChapterNo != null ? `（你目前学到第 ${maxChapterNo} 章）` : ""}
          </div>
          <div className="bn">
            不是你的问题——这个知识点还没讲到。下面照样给完整解法，
            但考试时以你学过的章节为准；等学到
            {chapters.length > 0 ? `第 ${chapters[0]} 章` : "相应章节"}再回来看会顺很多。
          </div>
        </div>
      )}

      {maybe.length > 0 && (
        <div className="beyond beyond-soft">
          <div className="bt">？ 可能用到了没学的内容</div>
          <div className="bl">
            涉及：
            {maybe
              .map((b) => b.topic)
              .filter(Boolean)
              .join("、")}
            （模型判断可能超纲，但没能定位到具体章节，仅供参考）
          </div>
        </div>
      )}
    </>
  );
}
