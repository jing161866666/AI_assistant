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

不同账号的模型池差异很大。当前分工是**两家供应商**（详细依据与踩坑见 **[模型应用.md](模型应用.md)**）：

| 角色 | 任务 | 模型 | 供应商 |
|---|---|---|---|
| reason | 解题（smart）、判对错 | `deepseek-reasoner` | DeepSeek |
| fast | 用户选「快答」 | `deepseek-chat` | DeepSeek |
| extract | 排日程、习惯抽取、举一反三 | `deepseek-chat` | DeepSeek |
| vision | 看图 / 转录 | `qwen3-vl-plus` | qwen（百炼） |
| embed | 向量化 | `qwen3.7-text-embedding`（dim=1024） | qwen（百炼） |

```powershell
npm run probe        # 拉 /v1/models 并逐个实测，输出可用模型
npm run test-llm     # 用真实代码路径验证五个角色
npm run bench:grade  # 判对错专项：错答案必须判错，否则禁止换模型
```

换 Key、换账号或换模型后**先跑这几条**，再改 `.env`。特别注意：`FAST_*` 没配时
`reason`/`extract` 会回退到 qwen 的地址，但模型名仍是 `deepseek-*`，对端直接 400。

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

> 三阶段的门禁、步骤、验收标准见 **[TASKS.md](TASKS.md)**（任务总流程）。

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1 | 教材检索 + 解题 + 改错 + 错题本 | 已跑通，可用（教材库仅《大学物理(B)II》下册） |
| M2 | 习惯分析 + 进度 + 日程 + 学习路径 + 生成习题 | 进行中：进度与注入已落地，闸门 L1 与习惯抽取未做 |
| M3 | 教师端脱敏聚合 + 报告导出 + 汇聚端 | 未开始 |

M2 的剩余工作见 **[M2.md](M2.md)** 第八节「现状差距」（P0 三项：检索期章节过滤、已学集合判定、去掉 `PHY2` 静默默认）。

---

## 七、分享给别人看（给同事演示）

默认只监听 `127.0.0.1`，别人打不开。三种给同事看的方式，从省事到正式：

### 方式 A：同一 Wi-Fi，直接开端口（最简单）

```powershell
# 先停掉原来那个 127.0.0.1 的实例（Ctrl+C），再：
npm run share
```

启动后会打印一行 `局域网可访问 http://<你的内网IP>:8787/`，把这个地址发给同事就行。

前提与坑：

- 必须在**同一网段**（同一个 Wi-Fi/路由器）。校园网（如 SEU-WLAN）常开客户端隔离，别人会连不上——此时用手机热点给两边连着试。
- 防火墙：当前网络为「公用」时，Windows 已为 Node.js 放行入站。若被拦，管理员 PowerShell 执行：
  ```powershell
  New-NetFirewallRule -DisplayName "AI学习伙伴 8787" -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow
  ```
- 演示完 `Ctrl+C` 关掉即可；默认值仍是 `127.0.0.1`，不会一直敞开。

### 方式 B：临时公网隧道（远程同事 / 不想暴露整个网段）

不改代码、不开防火墙，本机服务保持 `127.0.0.1`：

```powershell
winget install --id Cloudflare.cloudflared    # 首次
cloudflared tunnel --url http://127.0.0.1:8787
```

命令会打印一个 `https://xxx-xxx.trycloudflare.com` 地址，发给谁都能打开（含手机）。关掉命令窗口即失效。

### 方式 C：没网络条件

`npm start` 打开后截图/录屏，重点截「解题带教材引用」「改错归因」「错题本」三页。

### 演示之前：先把数据隔离出来

**这个服务没有任何登录验证**，而 `data/learner.db` 里是你的真实对话、错题原文与上传文件。给团队看时用一份临时库，别把自己的记忆库摆出去：

```powershell
$env:DB_PATH = "./data/demo/learner.db"
npm run init-db      # 建一个空库
npm run share
```

另一个坑：`profile` 表是**单用户单行**，同一个实例多人访问会共用一份画像和错题本——同事的测试题会写进这份库。所以演示就用空库，别接着自己的真实库讲。

真要多人各用各的数据，那是加账号体系的事，别在演示里硬撑。

---

## 八、把教材库给同事（只给代码是不够的）

`data/textbook/*.db` 是**构建产物**，被 gitignore（版权 + 体积）。同事 clone 完代码、
界面跑得起来，但一问教材就是空的——这不是 bug，是缺文件。所以教材库要单独分发。

### 出包方：一条命令

```powershell
npm run pack:textbook
# → dist/textbook-pack/   5 个库 + manifest.json，约 32 MB
```

打包不是裸拷贝，而是 `VACUUM INTO` 导出的干净副本（原库是 WAL 模式，直接拷贝
可能丢掉未 checkpoint 的页），并把每个文件的 sha256 写进 `manifest.json`。
空库（0 chunk 的占位）会自动跳过——发出去只会在别人库里多出假科目。

### 接收方：两条命令

```powershell
# 网盘 / 内网共享 / 优盘，指向那个目录都行
npm run fetch:textbook -- --from D:\共享\textbook-pack

# 若目录挂在 HTTP 上（内网静态服务即可，不需要写后端）
npm run fetch:textbook -- --url https://some-host/textbook-pack
```

然后确认：

```powershell
npm run check:textbook
```

它会逐个库断言：meta 齐全 → chunk 数与 meta 一致 → 每条 chunk 都有同维度向量 →
FTS 索引条数一致 → 抽查一次 `MATCH` 真的能命中。这几项正好覆盖「检索返回空」
和「结果莫名其妙」的全部常见原因。

### 三条硬要求

1. **embedding 必须一致。** 教材库是 `qwen3.7-text-embedding` @ 1024 维预构建的。
   若 `.env` 里 `EMBED_DIM` 不是 1024，`fetch:textbook` 会**直接拒绝**而不是警告——
   维度不一致时检索不会报错，只会静默返回一堆无关段落，比崩溃更难发现。
2. **还要一个百炼 Key。** 检索要先把问题算成向量，没有 key 连检索都进不去。
   光有教材库走不到「解题带引用」。
3. **装完重启服务。** 新库在服务启动时才会自动登记成科目（`syncSubjectsFromTextbooks`）。

`manifest.json` 里有 sha256，所以传输通道不需要可信：优盘、微信、网盘都行，
损坏或被改过的文件会在解包时被挡住。也**不需要**为此搭下载站。

