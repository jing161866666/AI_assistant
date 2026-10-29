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

`npm run check` 会依次执行：lint（biome check）→ 类型检查（tsc）→ **11 套测试**。
**提交前必须通过。**

## 提交前守卫（已装好，每个克隆只需一次）

`npm run check` 里的测试会真实调用模型（约 2–3 分钟，依赖网络与配额），不适合塞进每次提交。
所以提交时只跑「快且确定」的部分，完整检查留给 push 前手动跑：

```powershell
git config core.hooksPath .githooks   # 每个克隆执行一次；本仓库已执行
npm run check:fast                    # = lint + typecheck，约 10 秒
npm run check                         # = 上面 + 11 套测试，push 前跑一次
```

`.githooks/pre-commit` 会拦住 lint 或类型检查不过的提交。真被拦住了：

```powershell
npx biome check --write src scripts web/src   # 90% 的情况这一条就修好了
```

**不要用 `git commit --no-verify` 绕过**——绕过一次，下一个人就得花半小时去找为什么 `npm run check` 是红的。

## 测试与数据安全

- 除 `test:calendar` 外，所有测试都用自己的临时库（`data/test-*.db`），不会写坏 `data/learner.db`。
- `test:calendar` 故意读真实 `learner.db`（要验证真实校历），但只读不写。
- 跑完测试若看到 `data/test-*.db` 残留，可以直接删（`data/*.db` 已被 gitignore）。

## 没有教材库时（新同事必读）

`data/textbook/*.db` 不在 git 里（构建产物，分发方式见 `README.md` 第八节）。
拿不到库的时候：

- 界面能跑，日程 / 错题 / 习惯 / 进度都能测；
- **教材检索、解题带引用、题库命中不可用**；
- `npm run test:bank` 会因缺 `course-phy.db` 失败，于是 `npm run check` 不会全绿——
  这是环境问题，不是你改坏了。

解决：问出包的人要一份 `npm run pack:textbook` 的输出，然后
`npm run fetch:textbook -- --from <那个目录>`，再 `npm run check:textbook` 确认。

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
| `npm run check` | 全套校验（lint + typecheck + 11 套测试） |
| `npm run check:fast` | 只跑 lint + typecheck（约 10 秒，pre-commit 用的就是它） |
| `npm run test` | 全部测试 |
| `npm run lint` / `npm run lint:fix` | lint / 自动修 |
| `npm run doctor` | 环境自检 |
| `npm run probe` | 探测本账号可用模型 |
| `npm run test-llm` | 五个模型角色真实连通（reason/fast/extract/vision/embed） |
| `npm run bench:models` | 同一道题横向比耗时（换模型前跑） |
| `npm run bench:grade` | 判对错专项（错答案必须判错，否则禁止换模型） |
| `npm run demo:calendar` | 打印调休效果 |
| `.\scripts\fb.ps1 list "/"` | 列教材镜像目录（凭据在 `.env`，见 `语料来源.md`） |
| `npm run dev` | 启动 API |
