# 校园垃圾分类引导与按需清运系统

课程项目原型。以宿舍区的三个示意站点为例，学生端根据物品和桶位状态给出投放指引，保洁端根据同一条满桶事件生成工单。相同物品可随桶位状态变化显示本站投放、去附近同类桶或等待清运。

[组员开发交接](HANDOFF.md)

- **学生投放屏**支持样例回放和照片、视频帧输入。页面上的灯模拟桶口指示灯。
- **保洁工作台**在校园点位图上标出满桶和设备状态。可筛选异常点位，点击站点查看各桶与复核状态。
- **设备模拟**发送带事件 ID 和时间戳的红外状态。后端合并重复报满，忽略过期事件。保洁员登记清运后，收到更新的未满读数才关闭工单。

站点名称、距离和桶种用于课程演示。实际部署时需按宿舍区实地桶身标识配置分类规则，并用实测步行距离替换示意距离。

校园核心区底图参照[港科大（广州）校方地图](https://studyathkustgz.hkust-gz.edu.cn/detail-819)绘制，点位是演示配置。底图随前端提供。

## 本地启动

需要 Node.js 22.12+、npm、Rust 工具链及 C 编译器（用于构建随项目打包的 SQLite）。从仓库根目录执行：

```bash
npm --prefix frontend ci
npm --prefix frontend run build
cargo run --locked --manifest-path backend/Cargo.toml
```

打开 [http://127.0.0.1:8080](http://127.0.0.1:8080)。学生端与保洁端可以在两个标签页同时打开。样例回放和模拟红外无需模型密钥。重置按钮会清空当前演示实例的事件和工单。

页头可切换中文和 English，浏览器会记住选择。本地规则和手动生成的 DeepSeek 建议均按当前语言显示。

## Jev 实时图片判断

在启动 Rust 服务的进程中配置环境变量 `TYPESAFE_API_KEY`，然后使用学生端的实时识别。浏览器会把照片或视频当前帧转成 JPEG，再由服务端发送到 TypeSafe System One。Jev 回答预设的 Choice 选项，应用将物品结果映射成四类桶位或一条澄清提示。模型遇到超出样例范围的物品时可以弃权。

请用只含目标物品的画面。演示样例回放使用固定结果。LFT2 请求 TypeSafe 时收到 HTTP 451，课程演示采用样例回放。实时入口需要可访问的运行环境及有效的 TypeSafe 凭据。[TypeSafe 图片接口](https://docs.typesafe.ai/images)

## 演示与验证

1. 在学生端识别空饮料瓶样例。A 站可回收桶亮灯。
2. 在模拟设备中将 A 站可回收桶设为满。保持同一张图片，学生端改为推荐可用同类桶。保洁端出现一张待清运工单。
3. 重复上报报满。保洁端保持一张活动工单。点击“已清运”，再上报一次满，看到待复核。
4. 模拟清空并上报未满。保洁端关闭工单，学生端恢复本站投放。

在独立、可重置的演示实例上运行端到端 API 检查：

```bash
cargo test --locked --manifest-path backend/Cargo.toml
python3 scripts/verify_demo.py --base-url http://127.0.0.1:8080
```

[清运仿真结果](evaluation/)包含固定巡检与按需调度的可复现对照。同一批模拟满桶事件下，两类流量的按需调度步行距离均更短，高峰场景的累计满桶等待时间更长。

## 清运分析

保洁工作台自动显示近 7 天的统计和本地规则建议。切换到近 28 天或工单发生变化时，结果会自动更新。统计包含时段内创建的满桶工单，平均关闭耗时仅计入有关闭时间的工单。旧数据库会自动增加该字段。

配置后端进程的 `DEEPSEEK_API_KEY` 可启用 DeepSeek 建议，默认模型为 `deepseek-flash`，可通过 `DEEPSEEK_MODEL` 设置。仅在点击生成且时段内有工单时发送汇总统计。服务未配置或返回错误时使用页面标注的本地规则。[DeepSeek 接口文档](https://api-docs.deepseek.com/guides/json_mode/)

## 素材

空饮料瓶照片由 Ron Lach 拍摄，用于演示样例。[Pexels 原图](https://www.pexels.com/photo/close-up-shot-of-a-person-holding-a-plastic-bottle-9037601/)和[使用许可](https://www.pexels.com/license/)
