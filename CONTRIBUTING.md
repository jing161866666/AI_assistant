# 参与开发

## 首次准备（10 分钟）

```powershell
# 1. Node 版本（>= 22.5，Node 24 已验证）
node -v

# 2. 安装依赖（注意：本机 npm 默认缓存目录无写权限）
$env:npm_config_cache = "D:\AI学习伙伴\.npm-cache"
npm install

# 3. 配置密钥（不要提交！）
Copy-Item .env.example .env
# 编辑 .env，填 LLM_API_KEY

# 4. 环境自检
npm run doctor

# 5. 初始化数据库 + 导入校历与课表
npm run init-db
npm run import:calendar
npm run import:timetable

# 6. 跑通全部校验
npm run check
```

`npm run check` 会依次执行：格式化检查 → lint → 类型检查 → 两套测试。
**提交前必须通过。**

## 提交前检查清单

- [ ] `npm run check` 全绿
- [ ] 改了表结构？→ `db/schema/*.sql` 和 `src/db/migrate.ts` **都已改**
- [ ] 新增了日程相关逻辑？→ 补一条断言到 `scripts/test-*.ts`
- [ ] 没有把 `.env`、`data/*.db`、`data/uploads/` 提交进来
- [ ] 没有在业务代码里硬编码节假日日期

## 分支与提交

```
main          始终可运行，受保护
feat/<主题>   新功能
fix/<主题>    修 bug
```

提交信息用中文或英文都行，但要说明**为什么**，不只是改了什么：

```
好：修复调休日不在学期区间内被漏算的问题
   9/20 早于第1周周一，resolveWeek 返回 0 被 continue 跳过，
   改为先查 teaching_day 再决定教学周与星期。
差：改了点东西
```

## 谁能改什么

| 目录 | 建议 owner |
|---|---|
| `src/schedule/`、`src/academic/` | 需要理解校历与调休规则，改动前先读 `ARCHITECTURE.md` |
| `db/schema/` | 任何改动都要同步 `migrate.ts`，建议 PR 里单独列出 |
| `src/llm/` | 改模型名必须先跑 `npm run probe` |
| `web/` | 需先定 `/api` 契约 |

## 不要做的事

1. **不要在 `.ps1` 里写中文字面量** —— PowerShell 5.1 按 ANSI 读无 BOM 文件，中文会破坏解析。中文从命令行参数传入。
2. **不要用 `term.totalWeeks` 这类 camelCase 读 DB 行** —— 见 `ARCHITECTURE.md` 第三条约定。
3. **不要提交 `.env`** —— 里面是真实 API Key。已经泄露过一次，务必保持 gitignore 生效。
4. **不要把教材 PDF 提交进仓库** —— 版权与体积双重问题，放 `data/uploads/` 且该目录已忽略。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run check` | 全套校验 |
| `npm run test` | 两套测试 |
| `npm run lint` | 仅 lint |
| `npm run format` | 自动格式化 |
| `npm run doctor` | 环境自检 |
| `npm run probe` | 探测可用模型 |
| `npm run demo:calendar` | 打印调休效果 |
| `npm run dev` | 启动 API |
