# 项目协作

- 项目是校园宿舍区垃圾分类与按需清运课程原型。前端在 `frontend/`，Rust API 和 SQLite 状态机在 `backend/`，可复现的合成事件实验在 `evaluation/`。
- LFT2 主工作区在 `/data/LFT-W02_data/xiqing/projects/campus-waste-dispatch`。Mac 可用于开发、演示和 TypeSafe 连通验证。
- 用 `npm --prefix frontend ci` 安装前端锁定依赖，用 `npm --prefix frontend run build` 做类型检查和生产构建，用 `cargo test --locked --manifest-path backend/Cargo.toml` 检查后端。
- 默认服务监听 `127.0.0.1:8080`。运行 `scripts/verify_demo.py` 前使用独立演示实例，因为该检查会重置模拟数据。启动方式见 README。
- 页面默认回放固定样例。验证实时 Jev 时仅使用专门准备的物品帧和服务进程环境变量 `TYPESAFE_API_KEY`。提交源码时排除密钥、数据库及拍摄原文件。
- 宿舍站点、红外状态和指示灯均为模拟。记录实验时注明数据来源，保留仿真种子或固定事件轨迹。
