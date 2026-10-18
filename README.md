# 新一代日戳管理系统

面向集邮者的日戳（邮戳）收藏管理桌面应用，同时内置一套全国邮政网点数据的抓取与比对工具链。

应用基于 **Electron**，在本地启动一个轻量 HTTP 服务器（默认 `127.0.0.1:19876`），
前端页面通过该服务器访问主进程中的爬虫引擎与数据目录，从而绕开 `file://` 协议的跨域限制。
**应用只监听回环地址；除主动抓取邮政官网数据，以及「邮件管理 · 查询」按需加载 17TRACK
查询组件（`www.17track.net`）外，不产生任何外部连接。**

---

## 功能概览

### 收藏管理（前端）

| 功能 | 说明 |
| --- | --- |
| 日戳录入 | 省 / 市 / 县三级联动表单，机构号自动生成，支持戳号增删、邮资机与风景日戳条件字段 |
| 邮资机戳 | 独立于日戳记录的一张表（侧边栏「数据管理 · 邮资机戳」），列示型号 / 编号 / 上环 / 下环 / 表头 / 打印日期 / 打印网点 / 备注；打印网点按 省 → 市 → 县 选定后再填名称，候选建议与「录入日戳」同源（本机日戳记录 + `base` 参考库）；列表可按要素升降序排序。首次启动自动把日戳记录里已填的邮资机信息移植过来，之后两边互不影响，可手动「从日戳记录移植」补拉 |
| 地图可视化 | ECharts 中国地图着色，支持省 → 市下钻，GeoJSON 全部本地加载 |
| 统计面板 | 收集总量与省 / 地 / 县覆盖数、省份排名表、采集日历热力图 |
| 工具箱 | 机构号生成器、信函条码校验与生成、条码展示、随机网点、网点检索 |
| 国际退信 | 独立于「待发 / 在途 / 妥收」的一张表（侧边栏「邮件管理 · 国际退信」），记录一件寄往境外的邮件被退回直至收回的全过程：寄达国家（地区）中文名 / 英文名 / 二字代码（同源 `js/countries.js`，选候选或填代码自动补齐三项）、寄出方式（航空 / SAL / 水陆路）、邮件号码（13 位）、寄出 / 寄达 / 返回 / 收回 四个时间、境外接收 / 出口互换局、邮路信息（可增删途经点，相邻两点之间可填运送信息）、备注。邮路与备注不占列，单击「寄达国家（地区）」单元格弹窗查看；列表可按要素升降序排序，支持 JSON 导出 / 导入 |
| 邮件查询 | 「邮件管理 · 查询」嵌入 17TRACK 官方 `externalcall.js` 组件，输入运单号即查（**需联网**，组件在首次进入该页时懒加载） |
| 日戳图片 | 录入表单内直接上传图片：EXIF 方向自动纠正、任意角度旋转、裁剪 / 增强、命名规范化、保存到统一目录 |
| 数据导入导出 | 基于 SheetJS 的 Excel 导入，CSV 导出 |
| 持久化 | 浏览器 `localStorage`（详见 [前端数据存储](#前端数据存储)） |

### 日戳图片上传与处理

「录入日戳」表单里的**日戳图片**区支持一次选一张或多张本地图片（也接受拖拽），
每张图都在弹出的编辑器里走完「预览 → 裁剪 / 旋转 / 增强 → 命名 → 保存」。

| 环节 | 实现要点 |
| --- | --- |
| 校验 | 按文件**内容**嗅探格式（扩展名不可信），单张上限 50 MB，尺寸过小只提醒不拦 |
| EXIF 方向 | 自行解析 JPEG 的 Orientation 并在导入时把方向烧进像素 —— 与资源管理器看到的一致 |
| 旋转 | **任意角度**（滑块微调 + 数字输入，另备 90°/180°/重置按钮）。旋转只作用于画面，裁剪框始终是正的 |
| 裁剪 | 拖动框内移动、拖角/边改变大小，支持自由与 1:1 / 4:3 / 3:2 / 16:9 等固定比例 |
| 倾斜保护 | 非整数角度下裁剪框会按当前角度自动收紧，保证旋转后的框仍完全落在原图内（结果里不会掺进图外内容） |
| 编辑 | 会话 = 原图 + 参数（旋转 / 裁剪框 / 亮度·对比度·饱和度·锐度），编辑过程**不产生任何临时文件** |
| 撤销 | `Ctrl+Z` / `Ctrl+Y`，另有「重置增强」「重置旋转」；滑块一次拖动只记一个撤销点 |
| 命名 | `机构号_盖销时间_邮局名_序号.扩展名`，非法字符与路径分隔符统一清洗（规则见 `js/img-naming.js`） |
| 重名 | 不静默改名：弹窗让用户选 **覆盖 / 自动编号 / 取消** |
| 保存 | 服务端先写 `.part` → 校验大小 → `rename` 原子替换，中途失败不会留下半截文件 |
| 记录关联 | 记录只存**相对路径**（`photos: string[]`），缩略图经 `/images/*` 回读 |

输出尺寸的语义：**恒等于裁剪框的尺寸**，与旋转角度无关 —— 旋转改变的是
"框里装的是哪部分内容"，而不是输出形状（横图转 90° 后输出仍是横的，只是内容转了）。

关键约束：渲染层没有 Node 权限（这是 `launch.js` 能拿浏览器当窗口的前提），
所以文件系统操作全部落在服务端 `img-export.js`，由 `/api/images/*` 暴露；
渲染层只负责解码、编辑与编码，且**整条链路只编码一次**（JPEG 不会被反复压缩）。

图片默认写入 `output/images/<记录ID>/`，可用 `POSTMARK_IMAGES_DIR` 指到任意目录
（例如 `D:\ApplicationData\Images`）。记录尚未保存时上传的图片先落在 `_unfiled/`。

### 数据抓取与比对（主进程引擎）

「数据抓取」页面提供三个作业面板，全部由 `crawler-engine.js` 在主进程中执行，
前端通过 HTTP 轮询日志与进度：

1. **爬取数据** —— 从中国邮政官网（POST）与国家邮政局备案系统（SPB）抓取 31 个省级行政区的网点信息，
   按 GBK 编码写入 `output/post{缩写}-{日期}.csv` 与 `spb{缩写}-{日期}.csv`。
   可在界面上选择数据源、省份，并设置源间 / 省间请求间隔。
   **抓取结束只产出 output，不动应用内参考库**（参考库统一在对比环节刷新）。
2. **对比并更新 base** —— 调用外部工具 `txt_compare.exe` 逐省比对 `output` 与 `base` 的同名文件，
   生成报告，并算出「更新方案」。对比一跑完就按方案刷新应用内参考库（当前库 + base_old 归档），
   弹窗里给出「确认更新 base」按钮，确认后把方案落到 `base/`；弹窗正文分「更新方案」与「对比报告」两个标签页
   （前者说明确认后 base 会怎么变：归档构成 + 逐文件明细；后者是本次差异明细与报告全文），标签内容按需构建。
   base 是**覆盖式**更新，但涉及名称变化或撤销的记录不再被直接丢掉：

   | 情况 | 处理 |
   | --- | --- |
   | 普通记录（含新增） | 按 output 覆盖 `base/{前缀}+base.csv` |
   | 营业状态变化（暂停 / 装修中 / 临时停业 / 假期营业…） | 直接覆盖原有内容，不归档 |
   | 名称变化 | 更名前的旧名称那一条转入 `base/base_old.csv`，新名称进当前库 |
   | 撤销（名称带 `（撤销）`） | 该记录不进当前库，转入 `base/base_old.csv` |
   | 疑似撤下（output 里已消失的旧记录） | 转入 `base/base_old.csv` |

   `base/base_old.csv` 是**一个**不分省的文件（POST / SPB 混排，靠「来源」列区分），
   只保存「当前库里已经没有、但历史上存在过」的记录：某网点重新出现时会自动移出归档。
   归档记录仍可在「网点检索」里查到，带「历史」标记，可用「含历史归档」开关收起。
3. **横向对比（邮政 vs 邮管）** —— 对同一省份的 POST 与 SPB 数据做多阶名称匹配：
   精确 → 归一化 → 疑似（公共子串）→ 模糊 → 跨区县末次，输出可人工核对的报告。
   可选启用模糊匹配并设置阈值（默认 0.8）。

---

## 环境要求

- **Node.js**（依赖声明要求 `>= 14`，本项目在 v22 上开发验证）
- **Windows**（打包目标为 Windows 便携版；`txt_compare.exe` 为 Windows 可执行文件）
- 抓取功能需要联网访问 `iframe.chinapost.com.cn` 与 `zwfw.spb.gov.cn`

## 快速开始

```bash
npm install     # 安装依赖
npm start       # 开发模式启动（scripts/start.js 包装，会自动降级）
```

`npm start` 由 `scripts/start.js` 包装，做两件事：

**1）数据只有一份。** 固定使用项目内 `.userdata/` profile —— 受限身份写不了 `%APPDATA%`，
而普通身份默认写 `%APPDATA%`，两边各一份就得反复导出/导入。现在两种身份、每次启动都是同一份数据：

- 首次运行：把 `%APPDATA%\postmark-system` 里的记录复制过来（只读复制，原数据不动）；
- 之后若系统 profile 反而更新（例如用过 `npm run start:electron`），会先把它备份到
  `_recovery/profile-backup-<时间>/` 再同步过来，不会出现"这次的记录不见了"。

**2）窗口真的出来才算成功。** 受限环境里可能"进程活着但窗口永远不显示"。包装脚本设置
`POSTMARK_STARTUP_REPORT=<临时文件>`，`main.js` 在 `boot` / `server` / `shown` / `error`
节点回执，**只有 `ready-to-show` 之后 `win.isVisible()` 为真才回 `shown`**；收不到就换下一种参数：

| 顺序 | 启动参数 | 适用情形 |
| --- | --- | --- |
| ① | `--user-data-dir=<项目>/.userdata` | 正常环境（Chromium 沙箱保留） |
| ② | 再加 `--no-sandbox` | GPU 子进程建不出来：`GPU process launch failed: error_code=18`（18 = `SBOX_ERROR_CREATE_PROCESS`）→ `GPU process isn't usable. Goodbye.`；或受限身份下沙箱初始化整体被拒（静默退出、`0x80000003`） |
| ③ | 再加 `--disable-gpu-sandbox` | 只想关 GPU 沙箱、保留渲染进程沙箱时的兜底 |

成功的方式记进 profile 的 `.start-memory.json`，下次直接用它、不再重复试错。
启动前会检查 19876 端口是否被占用（换端口会让 Local Storage 的 origin 变化，记录看起来像丢了）。
`npm run start:electron` 是排错用的直连入口，它仍走 `%APPDATA%` —— 日常请统一用 `npm start`。

打包：

```bash
npm run build            # Windows 便携版（portable，输出到 release/）
npm run build:installer  # Windows 安装包
```

打包时会保留 `node_modules` 中的 `echarts` / `xlsx` / `jsbarcode` / `iconv-lite`，
并把 `txt_compare.exe` 解包到 `app.asar.unpacked`（asar 内的可执行文件无法直接 spawn）。
`base/` 会随包内置一份兜底副本，但**优先读取 exe 同级目录的 `base/`**：
替换便携版程序旁的 CSV 即可更新参考数据，无需重新打包。爬取产出同理落在 exe 同级的 `output/`。

---

## 目录结构

```
postmark/
├── main.js               # Electron 主进程：内置 HTTP 服务器、目录解析、生命周期
├── preload.js            # contextBridge 预加载脚本（仅暴露平台信息）
├── index.html            # 单页应用入口
├── css/style.css
├── js/                   # 渲染进程模块
│   ├── app.js            #   主应用，协调各视图与页面切换
│   ├── crawler.js        #   数据抓取页面（HTTP 客户端 + 报告弹窗渲染）
│   ├── countries.js      #   国家（地区）参考库：中文名 / 英文名 / 二字代码 + 检索
│   ├── data.js           #   行政区划参考数据（省→市→区县）
│   ├── form.js           #   录入表单（含日戳图片区）
│   ├── image.js          #   图片处理核心：校验 / EXIF / 编辑会话 / 渲染 / 导出
│   ├── image-editor.js   #   图片编辑器界面（预览 + 裁剪框 + 旋转/增强面板）
│   ├── img-naming.js     #   文件名规范化（与服务端共用同一份规则）
│   ├── map.js            #   ECharts 地图与下钻
│   ├── meterstore.js     #   邮资机戳独立数据表（localStorage CRUD + 从日戳记录移植）
│   ├── meter-list.js     #   邮资机戳列表与录入界面
│   ├── postodb.js        #   网点参考库（导入 CSV、市名校正、自动填充）
│   ├── returnstore.js    #   国际退信独立数据表（localStorage CRUD + 邮路结构）
│   ├── return-list.js    #   国际退信列表、录入表单与寄达地详情弹窗
│   ├── stats.js          #   统计面板
│   ├── store.js          #   收藏记录的 localStorage CRUD
│   ├── tools.js          #   工具箱
│   └── track.js          #   邮件管理 · 查询（17TRACK 组件懒加载与调用）
├── crawler-engine.js     # 爬虫引擎（主进程）：爬取 / 对比 / 横向对比
├── crawler-match.js      # 横向对比匹配引擎（纯函数）
├── crawler-intelligent.js# 智能判别对比（txt_compare 之后的语义级分析）
├── crawler-cities.js     # 区县名 → 市名 省级反查表（自动生成，勿手改）
├── img-export.js         # 图片落盘：目录解析 / 命名兜底 / 原子写入 / 删除
├── txt_compare.exe       # 外部对比工具（旧版 vs 新版 CSV 差异）
├── base/                 # 基准数据：31 省 × (POST + SPB) = 62 个 CSV
├── output/               # 抓取产出与报告（不入库，见 .gitignore）
│   └── images/           #   日戳图片（可用 POSTMARK_IMAGES_DIR 改到别处）
├── geo/                  # 本地 GeoJSON，按行政区划代码命名
├── scripts/              # 测试、回归与代码生成脚本（见下）
├── crawler.py            # Python 原版爬虫（历史脚本，详见「Python 工具」）
└── webui.py              # Flask + SQLite 的检索界面（历史脚本）
```

---

## 数据说明

### `base/` 与 `output/`

- `base/` 是**基准数据集**，手工维护的参考库，命名固定为 `post{缩写}+base.csv` / `spb{缩写}+base.csv`。
  同目录下的 `base_old.csv` 是**归档**：一个不分省的文件，只保存当前库里已经没有、但历史上
  存在过的记录（名称变化前的旧名称、带 `（撤销）` 的记录、output 里已消失的旧记录），
  列见下方「CSV 格式」。它由「对比并更新 base」自动维护，不需要手工编辑。
- `output/` 是**动态产出**，抓取结果为 `post{缩写}-{日期}.csv` / `spb{缩写}-{日期}.csv`，
  另含 `compare_report_*.txt`、`cross_compare_*.txt`、`intelligent_report_*.txt` 三类报告。
  对比时还会生成 `output/_refstage/` —— 应用后的 base 快照（当前库 + `base_old.csv`），
  供渲染进程刷新应用内参考库；它是可重建的中间产物，下一次对比会整目录重写。
  该目录已被 `.gitignore` 忽略。
- `output/images/` 是**日戳图片**，按记录 ID 分子目录（如 `output/images/k3f9a2/`），
  尚未关联记录的图片落在 `_unfiled/`。这个位置可以用环境变量 `POSTMARK_IMAGES_DIR` 覆盖，
  例如指到 `D:\ApplicationData\Images`。

### CSV 格式

所有 CSV 均为 **GBK 编码**（与数据源、Windows 环境下的 Excel 保持一致）。

| 来源 | 列 |
| --- | --- |
| POST（邮政官网） | `省, 市, 区/市/县, 网点名称, 邮编, 地址` |
| SPB（邮管局备案） | `所属省, 所属市, 所属县, 场所名称, 开办业务, 详情链接` |
| `base/base_old.csv` | `来源, 省, 市, 区/市/县, 网点名称, 邮编, 地址, 开办业务, 详情链接, 归档原因, 归档时间` |

`base_old.csv` 把两个来源并成一张表：`来源` 列取 `post` / `spb`，不适用的列留空
（POST 行没有开办业务/详情链接，SPB 行没有邮编/地址）；`归档原因` 取
`名称变化` / `撤销` / `疑似撤下`。读写两端都按**列名**定位，列顺序变化也不会读错。

省份缩写与行政区划代码的对应表定义在 `crawler-engine.js` 的 `PROVINCES`（31 项，不含港澳台）。

---

## 内置 HTTP 接口

由 `main.js` 提供，除标注外均为 `GET`：

| 接口 | 说明 |
| --- | --- |
| `/api/crawl/provinces` | 省份表（供界面多选） |
| `POST /api/crawl/start` | 启动作业，body 为 `{ kind: 'crawl' \| 'compare' \| 'apply-base' \| 'cross', ... }` |
| `/api/crawl/status?job=<id>&cursor=<n>` | 轮询作业状态与增量日志 |
| `POST /api/crawl/cancel` | 取消作业，body 为 `{ job: '<id>' }` |
| `/api/base-files` | 列出 `base/` 下的 CSV |
| `/api/output-files` | 列出 `output/` 下的 CSV |
| `/api/images/config` | 图片目录、大小上限等配置（界面用来显示"保存位置"） |
| `/api/images/exists?name=&subdir=` | 目标文件是否已存在（重名检测） |
| `/api/images/list?subdir=&limit=` | 列出已保存的图片 |
| `POST /api/images/save` | 保存图片，body 为 `{ dataUrl, fileName, subdir, conflict }` |
| `POST /api/images/delete` | 删除图片，body 为 `{ fileName, subdir }` |
| `/images/*` | 读取已保存的图片（缩略图与预览） |
| `/base/*`、`/output/*` | 读取对应目录中的文件 |
| 其余路径 | 项目目录内的静态文件 |

同类型作业不并发（避免两个抓取同时抢占用源站请求频率），重复启动返回 `409`。
请求体上限默认 1 MB（`/api/images/save` 放宽到能装下 50 MB 图片的 base64），
图片只允许写入图片目录内，路径穿越与"扩展名与实际内容不符"都会被拒。

---

## 前端数据存储

收藏记录放在 `localStorage`，PO 参考库与地图缓存放在 **IndexedDB**：

| 位置 | Key | 内容 |
| --- | --- | --- |
| localStorage | `postmark_records` | 全部收集记录（含旧版 `isClosed` → `status` 的兼容迁移） |
| localStorage | `postmark_meter_records` | 邮资机戳（独立数据表，与日戳记录互不影响） |
| localStorage | `postmark_meter_seeded` | 「从日戳记录移植」是否已自动执行过一次 |
| localStorage | `postmark_meter_sort` | 邮资机戳列表的排序要素与方向（界面偏好） |
| localStorage | `postmark_return_items` | 国际退信（独立数据表，与「待发 / 在途 / 妥收」互不影响） |
| localStorage | `postmark_return_sort` | 国际退信列表的排序要素与方向（界面偏好） |
| localStorage | `poref_base_signature` | `base/` 目录签名（文件名:大小:修改时间），用于跳过无变化的重复导入 |
| IndexedDB `postmark` / `kv` | `poref_meta` | PO 参考库元数据（当前总数、省份、来源、最后导入时间、归档条数、是否来自对比快照） |
| IndexedDB `postmark` / `kv` | `poref_data_{adcode}` | 按省行政区划代码分表的 PO 记录 |
| IndexedDB `postmark` / `kv` | `poref_base_old` | 历史归档记录（`base/base_old.csv` 的内容，带 `historical` / `archiveReason` / `archiveDate`） |
| IndexedDB `postmark` / `kv` | `geojson_cache_{adcode}` | 已加载的 GeoJSON 缓存 |

**为什么参考库不在 localStorage**：Chromium 对 localStorage 是每 origin 5 MiB 的硬配额，
而全量 `base/`（62 个 CSV、约 10.9 万条记录）序列化后约 2200 万字符，是配额的 4 倍以上。
旧实现写到第 3~4 个省就抛 `QuotaExceededError`，启动时必然弹
「网点数据导入失败：存储空间不足，请清理部分数据后重试」——而且因为覆盖导入会先清空，
每次失败还会把已有数据删掉一部分。现在参考库落在 IndexedDB（配额按磁盘可用空间计算），
localStorage 只留约 0.4 MB 的收集记录。

封装见 `js/idb.js`（`IdbKV`）。`PODatabase` 在启动时由 `ready()` 把 IndexedDB 全量
水合进内存，此后所有查询 API 保持**同步**；写入则先在一个事务里落盘、成功后再提交内存镜像。
从旧版升级时 `ready()` 会把 localStorage 里的旧副本搬进 IndexedDB 并清掉，
`PODatabase.legacyUpgrade()` 会要求本次强制重新导入 `base/`（旧签名可能只覆盖搬过来的那几个省）。

历史归档（`poref_base_old`）与当前库**分开存放**：它参与「网点检索」（`search()` 的
`includeHistory`，默认开），但**不计入** `count()`，也不进 `_buildAllRecords()` ——
录入候选、随机网点、统计都不会再推荐已撤销或更名前的旧名称。

参考库有两个来源：启动时从 `base/` 覆盖导入，以及对比完成时按快照刷新
（`PODatabase.refreshFromCompare()`，等价于「应用后的 base」）。后者会把
`poref_meta.fromCompare` 置位；`app.js` 的 `base/` 签名跳过逻辑看到它会强制下次启动
重新从 `base/` 导入——对比快照只是提交前的临时状态，`base/` 才是准的。

---

## 脚本与测试

`scripts/` 下的脚本用于验证 Node 移植版与 Python 原版的行为一致性，以及打包产物的完整性。
GUI 窗口无法在无桌面环境中自动化，因此涉及界面的验证改为「纯函数 + DOM 垫片」的方式（见 `test-report-modal.js`）。

```bash
# 离线测试（不联网、不依赖 Electron）
node scripts/smoke-crawler.js          # 爬虫引擎冒烟：解析、GBK 读写回环、对比与回写作业、
                                       # base_old 归档规则、对比产出的参考库快照
node scripts/test-intelligent-compare.js  # 智能判别子系统单测（内联 fixture）
node scripts/test-server-routes.js     # 主进程 HTTP 路由（用桩件加载真实 main.js）
node scripts/test-report-modal.js      # 报告弹窗渲染与日志折叠（DOM 垫片）
node scripts/gen-crawler-cities.js     # 由 js/data.js 重新生成 crawler-cities.js
node scripts/recover-localstorage.js   # 从 profile 的 leveldb 导出收藏记录（只读）
node scripts/test-poref-idb.js         # PO 参考库 IndexedDB 化：全新安装 / 重启水合 /
                                       # 旧版升级搬运 / merge 去重 / 清理路径，并复现旧写法的配额失败
node scripts/verify-idb-storage.js     # 真 Chrome + 临时 profile：验证参考库完整落进 IndexedDB（场景 A）
                                       # 以及旧版 localStorage 数据被搬运/清理（场景 B）
node scripts/test-image-export.js      # 图片落盘接口（/api/images/*）：保存 / 重名三策略 / 原子写入 /
                                       # 魔数校验 / 路径穿越防护 / 预览 / 删除
node scripts/test-image-core.js        # 图片处理核心：EXIF 八向归一化、任意角度旋转、裁剪、增强、导出
                                       # （含逐像素比对：预览与两条渲染路径必须一致）
node scripts/test-image-e2e.js         # 端到端：在真实应用页面里走完 选图→编辑→保存→存进记录→读回
node scripts/smoke-app-page.js         # 入口页自检：真实 index.html 能否加载全部模块、图片区是否就位
node scripts/check-fixture.js <测试脚本> FIXTURE_BODY   # 检查测试页面模板的语法（改完测试先跑这个）
```

> 带浏览器的几个需要 **Chrome 或 Edge**（无头模式），因此不在纯离线集合里；
> 找不到浏览器时会打印提示并跳过，可用 `--browser="<chrome.exe 路径>"` 指定。
> 它们把页面结果写到文件再读回，**不走管道**（受限环境里子进程管道会 EPERM，
> 而且 Chrome 的 `--dump-dom` 输出可能写满缓冲区后卡死）——详见 `scripts/_lib/browser-test.js`。
> 结果标记是每次运行随机生成的：`--dump-dom` 边写边出，用固定字符串会把
> "脚本源码里出现过这个词"误判成"页面已跑完"。
>
> 图片相关的验证之所以必须有浏览器：`js/image.js` 的核心是 canvas 坐标变换，
> 而 EXIF 归一化 / 旋转 / 裁剪的顺序一旦算错，表现就是「导出的图和预览不一样」，
> 这类问题只有逐像素比对才发现得了。

> `recover-localstorage.js` 与 `migrate-to-chrome.js` 直接解析 profile 里的
> Local Storage leveldb，因此只覆盖 **localStorage**（收集记录、`base` 签名）。
> PO 参考库自 2026-09-28 起改存 IndexedDB（`<profile>/Default/IndexedDB/`），
> 不再由这两个脚本导出；它可由 `base/` 目录随时重建。

加 `--net` 可追加联网的真实抓取用例：`smoke-crawler.js`、`test-server-routes.js`。

### 双份回归脚本（Python 基准 + JS 比对）

每一对中，`.py` 用仓库外的真实 Python 版生成基准，`.js` 跑 Node 移植版并逐字段比对：

| 验证对象 | 基准侧 | 比对侧 |
| --- | --- | --- |
| SPB 页面解析（正则 vs BeautifulSoup） | `compare-spb-parse.py` | `compare-spb-parse.js` |
| 横向对比匹配引擎 | `regression-cross-match.py` | `regression-cross-match.js` |
| 智能判别（手写 fixture 分支） | `regression-intelligent-compare.py` | `regression-intelligent-compare.js` |
| 智能判别（真实数据规模） | `regression-intelligent-realdiff.py` | `regression-intelligent-realdiff.js` |

> **注意**：生成基准的 Python 侧需要指向仓库外的真实爬虫，通过环境变量指定：
> `REAL_CRAWLER=E:\Git\Code\Python\barcode_scan\post_spb_crawler`。
> 本仓库内的 `crawler.py` 是 **2026-06-21 的旧拷贝**，不含智能判别代码，
> 直接用它跑基准会得到过期结果。

### 打包验证

```bash
node scripts/verify-packaged-artifacts.js [releaseDir]  # 校验 asar 解包与 iconv-lite 完整性
node scripts/smoke-packaged.js [exeDir]                 # 需先 build 并让 exe 保持运行
```

---

## Python 工具（历史脚本）

根目录的 `crawler.py` 与 `webui.py` 是这套系统的 Python 原版，Node 版引擎即由 `crawler.py` 移植而来。
它们仍可在 Python 环境下独立运行：

```bash
python crawler.py --source post --province 上海 北京 --delay 2.0   # 原始爬虫
python webui.py --port 8092                                        # Flask + SQLite 检索界面
```

与 Node 版相比，`crawler-engine.js` 有几处**有意为之**的差异：

- POST 解析的「市」字段弃用地址回溯，改为「抓取的区县名 + 地名表反查」（`crawler-cities.js`），更稳定；
- 对比后「是否更新 base」的交互式 `input()` 改为界面二次确认后单独调用 `applyBase()`；
- base 覆盖式更新时，名称变化 / 撤销 / 疑似撤下的记录转进 `base_old.csv` 归档而不是直接丢掉；
  参考库刷新也从「抓取结束」挪到了「对比」，见 `computeBaseUpdate()`；
- SPB 页面改用正则解析，不再依赖 `requests` / `bs4`。

`webui.py` 另有补充说明：它启动时会把 `base/` 下的 CSV 导入本地 SQLite，全程不联网，
提供省 / 市 / 县三级级联筛选与名称模糊搜索。

---

## 许可

MIT
