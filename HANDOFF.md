# Campus Loop 开发交接

Campus Loop 连接学生投放屏、桶位模拟器和保洁工作台。当前演示覆盖宿舍区 3 个模拟站点，每站 4 类桶。校园地标参考港科大（广州）校方导览，站点位置和调度距离按课程场景设定。[校方地图](https://studyathkustgz.hkust-gz.edu.cn/detail-819)

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

桌面保洁页以校园地图为主，右侧显示下一站和工单。屏幕宽度不超过 780 CSS 像素时改为底部导航，下一站、地图、工单依次排列。投放端在手机上识别完成后会滚动到投放指引。改动界面时，在浏览器的手机视口里走一遍站点选择、识别和地图筛选，并用英文复查按钮是否能完整显示。

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
3. 在服务设置里连接 `XiqingPeng/campus-waste-dispatch` 的 `main`。部署健康后，在 Networking 生成 HTTPS 域名。[Railway 服务来源](https://docs.railway.com/services)
4. 用未登录的手机打开链接，核对投放、地图和本地规则分析。再用组内口令登录，模拟满桶并清运。在独立演示数据上重部署一次，确认工单仍然存在。

Railway 将 SQLite 保存在挂载卷的 `campus-waste.sqlite3` 中。缺少卷或组内口令时，服务启动会报错。浏览、样例回放和规则统计可直接访问。设备上报、清运确认、重置和在线 AI 需要组内登录。口令单独发给队友，浏览器使用 HTTPS 会话 Cookie。

## 分工入口

| 可以并行的工作 | 入口 | 交付检查 |
| --- | --- | --- |
| 校园地图与交互 | `frontend/src/campus-map.tsx`、`campus-drawing.ts`、`cleaner.tsx` | 切换站点、筛选异常、查看四类桶与复核状态 |
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
| `GET /api/state` | 获取站点、桶位、所有工单和推荐工单 ID |
| `GET /api/guidance?station_id=a&category=recycle` | 返回本站、替代站或等待 |
| `POST /api/sensor` | 提交 `event_id`、`bin_id`、`status`、`observed_at`。状态为 `available`、`full` 或 `unknown`，时间为 Unix 毫秒 |
| `POST /api/tickets/{id}/collect` | 确认清运并等待新采样。再次报满进入待复核，新的未满采样关闭工单 |
| `POST /api/recognize` | `mode=replay` 配合样例 ID。 `mode=live` 配合图片 data URL |
| `GET /api/analysis?days=7&lang=en` | 读取本地统计与规则建议。支持 7 天或 28 天，页面切换范围、语言或工单变化后自动刷新 |
| `POST /api/analysis` | 点击生成时提交 `days` 和可选的 `lang`。支持 `zh-CN`（默认）和 `en`，返回对应语言的建议与证据 |
| `POST /api/demo/reset` | 清空当前演示实例的事件和工单，并将桶位设回可投放 |

分析按工单创建时间筛选最近 7 或 28 天。已关闭工单的耗时从开单算到未满读数。旧记录若缺关闭时间，仍计入工单数量。规则分析始终基于 SQLite 记录。有密钥且时段内有数据时，点击生成会将汇总统计交给 DeepSeek 撰写建议。

## 联调与交付

从仓库根目录运行检查。HTTP 脚本会重置数据，应指向可丢弃的实例。

```bash
npm --prefix frontend run build
cargo test --locked --manifest-path backend/Cargo.toml
python3 evaluation/dispatch_compare.py | diff -u evaluation/results.csv -
```

```bash
WASTE_BIND=127.0.0.1:8081 WASTE_DB_PATH=:memory: cargo run --locked --manifest-path backend/Cargo.toml
# 另一个终端
python3 scripts/verify_demo.py --base-url http://127.0.0.1:8081
```

课程演示可先识别空瓶，再模拟 A 站可回收桶报满。学生端改道，保洁端生成工单，地图点位变为满桶。登记清运并上报未满后，工单关闭。最后在保洁端点击「生成分析」，确认窗口内的工单数量、已关闭数量和平均耗时。

当前已验证浏览器点位选择、异常筛选、分析显示、7/28 天统计、SQLite 工单流转及 DeepSeek 模拟服务的请求与响应。后续联调需补一次带密钥的 DeepSeek 实际请求和一次 Jev 实时识别，并记录所用模型、输入和返回结果。涉校内实测时，先核对宿舍实际桶身分类和步行距离。
