# Real-time Market Data Monitor

这是一个现代化的高性能实时市场数据监控系统。项目采用 Monorepo 架构，后端使用 Rust 重构以追求极致性能，前端使用 SolidJS 构建响应式界面，并配备了基于 Playwright 的数据采集器。

## ✨ 核心特性

*   **高性能后端**: 基于 Rust (Axum + Tokio) 构建，利用异步 I/O 和 WebSocket (Socket.IO) 实现毫秒级数据推送。
*   **响应式前端**: 使用 SolidJS + Vite 构建，无虚拟 DOM 架构，确保在高频数据更新下的流畅渲染。
*   **智能数据采集**: 使用 Playwright + 浏览器指纹伪装，通过注入脚本高效捕获动态网页数据变更。
*   **图形化控制台**: 内置基于 PySide6 的 GUI 控制面板 (`run_gui.py`)，方便一键管理多进程任务。
*   **图片代理与缓存**: 后端内置图片代理及持久化磁盘缓存机制，解决跨域及访问限制问题。

## 🏗 技术栈

### Core
*   **Package Manager**: pnpm (Workspaces)
*   **GUI Controller**: Python (PySide6)

### Packages

| Package | Role | Tech Stack |
| :--- | :--- | :--- |
| **`packages/backend`** | 核心服务 | **Rust**, Axum 0.8, Socketioxide, Tokio, Sqlx (SQLite), Reqwest |
| **`packages/frontend`** | 用户界面 | **SolidJS**, Vite, TypeScript, Lightweight-charts, Socket.io-client |
| **`packages/extractor`** | 数据采集 | **Node.js**, Playwright-Extra, TypeScript |
| **`packages/shared-types`** | 类型共享 | TypeScript Interface definitions |

## 🚀 快速开始

### 前置要求
*   [pnpm](https://pnpm.io/)
*   [Rust Toolchain](https://www.rust-lang.org/)
*   [Python 3.10+](https://www.python.org/) (用于 GUI)
*   [Node.js 20+](https://nodejs.org/)

### 安装依赖

```bash
pnpm install
```

### 启动项目

#### 方式一：使用 GUI 控制面板 (推荐)

项目自带一个 Python 编写的图形化管理工具，可以方便地查看日志和控制各个服务的启停。

```bash
# 需要安装 PySide6
pip install PySide6

# 启动控制面板
python run_gui.py
```
在 GUI 中，你可以点击按钮分别启动：
*   `dev:backend`: 启动 Rust 后端
*   `dev:frontend`: 启动前端页面 (http://localhost:5173)
*   `start:hotlist` / `start:meme`: 启动不同的数据采集脚本

#### 方式二：命令行启动

如果你更喜欢命令行：

```bash
# 同时启动后端和前端
pnpm dev

# 或者全量启动 (后端 + 前端 + 采集器)
pnpm dev:full

# 仅构建
pnpm build
```

## 📂 项目结构

```
.
├── packages/
│   ├── backend/        # Rust 后端服务
│   ├── frontend/       # SolidJS 前端项目
│   ├── extractor/      # Playwright 数据采集脚本
│   └── shared-types/   # 前后端共享的 TS 类型定义
├── run_gui.py          # Python GUI 任务管理器
├── package.json        # 项目根配置
└── pnpm-workspace.yaml # Monorepo 工作区配置
```

## 🔧 核心组件详解

### Backend (Rust)
作为数据中继站，它监听来自 `extractor` 的数据更新，并通过 Socket.IO 广播给所有连接的 `frontend` 客户端。同时提供 HTTP API (`/desired-fields`) 供配置查询，以及 `/image-proxy` 用于图片资源的代理和缓存。支持 `cargo-watch` 热重载。

### Extractor (Node.js/Playwright)
作为一个独立的进程运行。它启动一个带隐匿插件的浏览器实例，注入脚本以 ~1000ms 的频率检测目标网页的数据变化，并通过 Socket.IO 将增量数据发送给后端。

### Frontend (SolidJS)
连接后端的 Socket.IO 服务，接收实时数据流并使用表格或图表进行渲染。启动时会自动同步后端的监控字段配置。