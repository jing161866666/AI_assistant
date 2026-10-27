# AI 学习伙伴

接入大语言模型的本地学习助手：以**本地数据库作为延长上下文**，沉淀学习习惯、教材进度、日程与目标，并向上汇聚为面向教师的教学改进反馈。

当前阶段：**M1 骨架已跑通**（数据库 / 自检 / API 服务），模型与检索能力待接入。

---

## 一、环境要求

| 组件 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 22.5（已在 24.11.1 验证） | 唯一运行时 |
| SQLite | 内置（已验证 3.50.4） | `node:sqlite`，**无需安装** |
| 包管理器 | npm（已验证 11.6.2） | corepack 的 pnpm 缓存损坏，暂用 npm |

**不需要**：Docker、Python、Ollama、WSL、独立向量数据库、独立全文检索引擎。

已验证可用的关键能力（`npm run doctor` 会逐项检查）：

- `node:sqlite` 可直接读写
- **FTS5** 中文全文检索可用（`unicode61`，无需分词器）
- **Float32 向量以 BLOB 存储并正确回读** —— 教材向量不需要 `sqlite-vec` 扩展

> 已知本机环境问题：npm 默认缓存目录 `D:\Program Files\nodejs\node_cache` 无写权限。
> 安装依赖时需指定项目内缓存：
> ```powershell
> $env:npm_config_cache = "D:\AI学习伙伴\.npm-cache"
> npm install
> ```

---

## 二、快速开始

```powershell
cd D:\AI学习伙伴

# 1. 安装依赖（首次）
$env:npm_config_cache = "D:\AI学习伙伴\.npm-cache"
npm install

# 2. 环境自检
npm run doctor

# 3. 初始化（或升级）数据库
npm run init-db

# 4. 启动 API 服务
npm run dev
```

服务默认监听 `http://127.0.0.1:8787`。

### 配置模型 Key

```powershell
Copy-Item .env.example .env
```

然后编辑 `.env`，**只需填第 5 行的 `LLM_API_KEY`**。
`EMBED_API_KEY` 留空会自动回退用 `LLM_API_KEY`。
推荐阿里云百炼：一个 Key 同时提供对话 / 视觉 / 嵌入三个能力。

> 自检会识别 `sk-请替换` 这类占位符并判为**未配置**，避免假通过。

### 模型名必须实测，不能抄文档

不同账号的模型池差异很大。本机实测（2026-07，百炼 compatible-mode）：

| 角色 | 实际可用 | 不可用 |
|---|---|---|
| reason | `qwen3.8-max` | — |
| extract | `qwen-flash` | `qwen-turbo`（429 限流） |
| vision | `qwen3-vl-plus` | `qwen-vl-max`（404 不存在） |
| embed | `qwen3.7-text-embedding`（dim=1024） | — |

```powershell
npm run probe      # 拉 /v1/models 并逐个实测，输出可用模型
npm run test-llm   # 用真实代码路径验证四个角色
```

换 Key 或换账号后**先跑这两个命令**，再改 `.env`。

---

## 三、数据分层

```
data/learner.db         学生本地记忆库（私密，18 张表）
data/textbook/*.db      教材库（只读，按课程预构建，全校共用）
data/uploads/           用户原始文件，永不删
data/exports/           导出的教师反馈报告
```

三库分离的原因：

- **教材库只读且全校一致** —— 学生只下载，不在本地解析 PDF、不在本地算 embedding。
  5000 名学生只构建一次，且知识点 ID 全局对齐，教师端才聚得起来。
- **记忆库私密** —— 对话、代码、错题原文永不上传。
- **聚合库独立（M3）** —— 教师端只接收脱敏统计摘要，服务器上不存在原文。

---

## 四、表结构要点

`learner.db` 共 18 表，设计上依赖三条规则：

1. **`event` 只追加，是唯一事实来源。** 其余表（习惯、进度）都是可由事件流重算的结论。
   老师问「这周他做了什么」只能靠事件流回答。
2. **`consent` 独立成表**，含授权范围与撤回时间。学生撤回后，其数据须立即从教师聚合中排除，
   但历史仍留审计。这项「软排除」必须一开始就设计，后期补等于重写所有查询。
3. **习惯按维度结构化存储**（`habit` + `habit_evidence`），不存自然语言摘要——
   摘要会随上下文增长而变得越来越糊。

`textbook.db` 共 8 表，其中 `knowledge_point.code` 是教师端聚合的**唯一对齐锚点**，
只能由教材库统一制定，不能由各学生端自行命名。

---

## 五、已实现接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 数据库、教材库、模型配置的一次性体检 |
| GET | `/api/profile` | 读取学生档案 |
| POST | `/api/profile` | 写入 / 更新学生档案 |
| GET | `/api/subjects` | 已选科目 |

### 调试注意：中文编码

用 PowerShell 调接口时，`-Body` 传字符串会按 ASCII 编码，中文变 `????`。
必须显式转 UTF-8 字节：

```powershell
$json  = '{"nickname":"测试同学"}'
$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
Invoke-RestMethod -Uri http://127.0.0.1:8787/api/profile -Method Post `
  -Body $bytes -ContentType "application/json; charset=utf-8"
```

浏览器 `fetch` 默认即 UTF-8，前端无此问题。

---

## 六、当前进度

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1 | 教材检索 + 解题 + 改错 + 错题本 | 骨架完成，待接模型 |
| M2 | 习惯分析 + 进度 + 日程 + 学习路径 + 生成习题 | 表已就绪，逻辑待写 |
| M3 | 教师端脱敏聚合 + 报告导出 + 汇聚端 | 未开始 |

### 待办

- [ ] `src/rag/` 混合检索（FTS5 + 向量余弦，RRF 融合）
- [ ] `src/llm/` 四角色调用封装（含 zod 校验的结构化抽取）
- [ ] `src/upload/` PDF / DOCX / 图片解析与切片
- [ ] `scripts/build-textbook.ts` 教材库构建脚本
- [ ] `src/memory/` 上下文组装（每次回答按习惯 + 进度注入）
- [ ] `web/` 前端（Vite + React）
- [ ] `scripts/export-report.ts` 教师反馈导出
