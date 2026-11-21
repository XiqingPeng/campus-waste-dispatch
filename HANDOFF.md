# Campus Loop 开发交接

Campus Loop 连接学生投放屏、桶位模拟器和保洁工作台。学生投放演示覆盖宿舍区 3 个模拟站点，每站 4 类桶；保洁工作台单独覆盖全校 50 个生活垃圾桶模拟点位（GZ-001～GZ-050）。校园地标参考港科大（广州）校方导览，站点位置和调度距离按课程场景设定。[校方地图](https://studyathkustgz.hkust-gz.edu.cn/detail-819)

## 从 GitHub 跑起来

需要 Git、Node.js 22.12+、npm、Rust 工具链、C 编译器。仿真和 HTTP 验证使用 Python 3。

```bash
git clone https://github.com/XiqingPeng/campus-waste-dispatch.git
cd campus-waste-dispatch
npm --prefix frontend ci
npm --prefix frontend run build
cargo run --locked --manifest-path backend/Cargo.toml
```

浏览器打开 [学生投放屏](http://127.0.0.1:8080/#student)或[保洁工作台](http://127.0.0.1:8080/#cleaner)。前端开发时保持 Rust 服务运行，在另一个终端执行 `npm --prefix frontend run dev`。Vite 将 `/api` 代理到 Rust 的 8080 端口，可用 `VITE_API_TARGET` 指向其他实例。

保洁页顶部显示待清运、超时待处理、今日已完成、在线设备。桌面端地图与工单并排，下方用选项卡切换历史与分析；窄屏改为单列和底部导航，地图可独立滑动、缩放。投放端在手机上识别完成后会滚动到投放指引。改动界面时，在浏览器的手机视口里走一遍站点选择、识别和地图筛选，并用英文复查按钮是否能完整显示。

样例回放和规则分析开箱即用。需要验证在线模型时，在后端进程的环境里配置对应凭据，再启动服务。密钥通过各自的本地秘密管理工具或终端隐藏输入加载。

| 变量 | 用途 |
| --- | --- |
| `TYPESAFE_API_KEY` | 用 Jev 判断学生端上传的图片或视频帧 |
| `DEEPSEEK_API_KEY` | 用 DeepSeek 生成基于工单统计的清运建议 |
| `DEEPSEEK_MODEL` | 可选，默认为 `deepseek-flash` |
| `WASTE_BIND` | 后端监听地址，默认为 `127.0.0.1:8080` |
| `WASTE_DB_PATH` | SQLite 文件，默认为 `data/campus-waste.sqlite3`。独立演示可设为 `:memory:` |
| `WASTE_ACCESS_KEY` | Railway 必填的组内口令。使用随机生成的 32–256 字节口令，本地可选 |

## Railway 上线

从仓库根目录部署一个服务即可。根目录的 Dockerfile 构建前端和 Rust 二进制。一个 Axum 进程同时服务网页和 `/api`。Railway 使用注入的 `PORT`，健康检查走 `/api/health`。

1. 在免费工作区新建项目和一个空服务。给该服务挂载持久卷，挂载路径设为 `/data`。保持单实例，由 Railway 注入 `RAILWAY_VOLUME_MOUNT_PATH`。[Railway 挂载卷](https://docs.railway.com/volumes)
2. 用密码管理器生成随机口令，添加为该服务的 `WASTE_ACCESS_KEY` 密封变量。需要在线建议时再添加 `DEEPSEEK_API_KEY`。需要实时识别时再添加 `TYPESAFE_API_KEY`。[Railway 服务变量](https://docs.railway.com/variables)
3. 在服务设置里连接 `XiqingPeng/campus-waste-dispatch` 的 `main`，并设置健康检查路径为 `/api/health`。部署健康后，在 Networking 生成 HTTPS 域名。[Railway 服务来源](https://docs.railway.com/services)
4. 用未登录的手机打开链接，核对投放、地图和本地规则分析。再用组内口令登录，模拟满桶并清运。在独立演示数据上重部署一次，确认工单仍然存在。

Railway 将 SQLite 保存在挂载卷的 `campus-waste.sqlite3` 中。缺少卷或组内口令时，服务启动会报错。浏览、样例回放和规则统计可直接访问。设备上报、清运确认、重置和在线 AI 需要组内登录。口令单独发给队友，浏览器使用 HTTPS 会话 Cookie。

## 分工入口

| 可以并行的工作 | 入口 | 交付检查 |
| --- | --- | --- |
| 校园地图与交互 | `frontend/src/collection-map.tsx`、`cleaner.tsx`、`backend/data/collection-points.json` | 核对 50 点位、7 分区、地图与工单联动、未知设备与复核状态 |
| 设备与工单 | `backend/src/db.rs`、`main.rs` | 同一桶重复报满只保留一张活动工单。清运确认后收到新读数才改变复核状态 |
| 识别与 AI 分析 | `backend/src/vision.rs`、`analysis.rs`、`frontend/src/dispatch-analysis.tsx` | 回放和实时来源有明确标识。建议旁展示服务端计算的依据 |
| 仿真、报告和演示 | `evaluation/`、`scripts/verify_demo.py` | CSV 可复现。记录仿真输入、实际观察和仍待实测的主张 |

从最新的 `main` 开任务分支。如果有仓库写入权限，可以直接推送分支。其他组员可从 fork 提交 PR。碰到共享文件，先在 PR 写清会改变的 API 字段和界面行为。PR 里附上跑过的命令与相关界面截图，便于其他组员复查。

```bash
git switch main
git pull --ff-only origin main
git switch -c feat/short-description
```

## 接口与数据口径

| 接口 | 用途 |
| --- | --- |
| `GET /api/state` | 获取原分类站点、全部桶位与工单、推荐工单 ID，以及独立的 `collection_points` 50 点位目录 |
| `GET /api/guidance?station_id=a&category=recycle` | 返回本站、替代站或等待 |
| `POST /api/sensor` | 提交 `event_id`、`bin_id`、`status`、`observed_at`。状态为 `available`、`full` 或 `unknown`，时间为 Unix 毫秒 |
| `POST /api/tickets/{id}/collect` | 确认清运并等待新采样。再次报满进入待复核，新的未满采样关闭工单 |
| `POST /api/recognize` | `mode=replay` 配合样例 ID。 `mode=live` 配合图片 data URL |
| `GET /api/analysis?days=7&lang=en&scope=collection` | 读取本地统计与规则建议。支持 7 天或 28 天，页面切换范围、语言或工单变化后自动刷新 |
| `POST /api/analysis` | 点击生成时提交 `days`、可选的 `lang`、`scope=collection`。支持 `zh-CN`（默认）和 `en`，返回对应语言的建议与证据 |
| `POST /api/demo/reset` | 清空当前演示实例的事件和工单；原分类桶恢复可投放，GZ 清运点位恢复未知 |

`scope` 默认 `sorting`（原分类桶），保洁页显式传 `collection`（50 点位）。分析按工单创建时间筛选最近 7 或 28 天。已关闭工单的耗时从开单算到未满读数。旧记录若缺关闭时间，仍计入工单数量。规则分析始终基于 SQLite 记录。有密钥且时段内有数据时，点击生成会将汇总统计交给 DeepSeek 撰写建议。

## 联调与交付

从仓库根目录运行检查。HTTP 脚本会重置数据，应指向可丢弃的实例。

```bash
npm --prefix frontend test
npm --prefix frontend run build
cargo test --locked --manifest-path backend/Cargo.toml
python3 evaluation/dispatch_compare.py | diff -u evaluation/results.csv -
```

```bash
WASTE_BIND=127.0.0.1:8081 WASTE_DB_PATH=:memory: cargo run --locked --manifest-path backend/Cargo.toml
# 另一个终端
python3 scripts/verify_demo.py --base-url http://127.0.0.1:8081
```

学生端演示仍可识别空瓶、模拟 A 站可回收桶报满并观察改道。保洁端独立选择 GZ 点位上报满桶，地图和队列同步出现工单；确认清运后进入待设备复核，模拟器上报新的未满读数后关闭，计入今日完成和历史。两组数据在页面和分析中分开，避免 12 个分类桶混入 50 点位指标。

当前已验证浏览器点位选择、异常筛选、分析显示、7/28 天统计、SQLite 工单流转及 DeepSeek 模拟服务的请求与响应。后续联调需补一次带密钥的 DeepSeek 实际请求和一次 Jev 实时识别，并记录所用模型、输入和返回结果。涉校内实测时，先核对宿舍实际桶身分类和步行距离。

## 50 点位与在线状态

目录按照实施文档的编号和分区：教学科研 16、饭堂 5、图书馆 3、演讲厅 3、宿舍 13、体育 4、行政/活动中心/入口 6。名称和底图坐标参考单文件 Demo，坐标为相对底图的 0～1 值，不用于路线或距离计算。底图来源和 OSM 署名见 `backend/data/README.md`。

启动时幂等新增 GZ-001～GZ-050，每点一个 residual 桶，初始状态 unknown。SQLite 自动补充 `received_at`，已有分类数据、历史工单与认证配置保留。原 12 个分类桶继续存在，因此原始 `/api/state` 有 62 个桶；前端按目录拆分两种视图。有效新上报的服务端接收时间用于在线判断：状态已知且最近 120 分钟内收到上报才计为在线；未知和从未上报不会伪装成未满。超时阈值为 20 分钟，待复核任务不计入待清运/超时卡片。

## DeepSeek 共享配置

「清运分析」只保留 DeepSeek，无服务商或 AI 选择下拉框。统计图表仍使用后端工单汇总；“查看基础建议”使用规则，“生成智能建议”调用 DeepSeek。

组内登录后打开“配置 API”，填写 API Key 和模型名称。连接测试向官方 `https://api.deepseek.com/chat/completions` 发送一次最多 32 输出 token 的 JSON 请求，不含工单；成功仅表示当前填写内容通过测试，修改后需保存才生效。测试失败使用固定错误提示，不回传供应商原始错误或密钥。

保存后立即生效，所有已登录组员跨设备共享额度，并可更新配置。服务端仅返回 configured/model/source，绝不回显密钥；API Key 留空保留现有密钥。前端不将密钥写入 localStorage、sessionStorage 或 GitHub。

配置保存在数据库同目录的 `deepseek-config.json`，Unix 权限 0600，采用临时文件加原子替换写入；Railway 上位于持久卷 `/data/`，部署重启后保留。该文件包含真实密钥，应按服务器秘密文件管理，已加入 Git 忽略且不进入 Docker 构建。它不是 Railway Variables 的修改：存在保存文件时优先使用文件，否则兼容 `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` 环境变量。组内口令 `WASTE_ACCESS_KEY` 不受影响。

配置查询/保存/测试分别使用 `GET /api/model-config`、`POST /api/model-config`、`POST /api/model-config/test`，均要求组内认证。测试和生成会消耗提供方额度，不自动触发；没有有效密钥时不能声称模型可用。开发验证使用独立测试实例与模拟供应商，真实密钥需由用户在页面填写后测试。

## 模拟点位在线控制

保洁端设备模拟器支持当前点位“设为在线／设为离线”及全校 50 点位批量操作。`POST /api/demo/connectivity` 需要组内认证，JSON 为 `{ "target": "GZ-001" | "all", "online": true | false }`，只影响 GZ 点位。设置在线刷新 received_at，未知点位初始化为未满；设置离线保存独立 simulated_offline 标记，保留最后桶状态、上报时间与工单。连接切换本身不会创建、关闭或重开工单。新有效传感器上报自动恢复在线，过期／重复上报不取消离线设置。仍遵循 120 分钟无有效上报即离线的规则。SQLite 幂等增加字段，重启保留模拟状态；重置演示数据清除此标记。
