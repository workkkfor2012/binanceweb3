<!-- README.MD -->
`packages\frontend`这是前端代码
`packages\extractor`这是爬虫代码
`packages\backend`这是后端代码

实时市场数据监控面板 (Rust 后端版)

一个现代化的、高性能的实时数据监控面板。项目后端已使用 Rust (Axum + Tokio + Socketioxide) 重构，以追求极致的性能和并发能力。

项目通过 pnpm Workspaces 进行包管理。它通过 Playwright 脚本从动态网页中提取数据，经由一个高性能的 Rust 后端，利用 WebSocket 实时推送给一个用 SolidJS 构建的、响应迅速的前端界面。

核心架构

本项目采用基于 pnpm Workspaces 的 monorepo（单一代码库）架构，将整个系统解耦为四个独立的、职责分明的包：

packages/extractor (数据提取器)

技术: Playwright-Extra, TypeScript

职责: 作为一个独立的 Node.js 进程，启动一个带代理的浏览器实例访问目标网页。通过 page.addInitScript 注入一个高效的浏览器脚本，以极高频率（~1000ms）检测并提取数据变更。一旦有数据更新，立即通过 Socket.IO 将增量数据发送给后端。

packages/backend (后端服务)

技术: Rust, Axum, Socketioxide, Tokio, Reqwest

职责:

数据中继站: 监听来自 extractor 的 data-update 事件，并立即将这些数据广播给所有连接的前端客户端。

配置接口: 提供一个 /desired-fields API 端点，用于向前端暴露当前系统监控的数据字段列表。

图片代理与磁盘缓存: 提供一个 /image-proxy 路由。前端请求的外部图片会由后端代为抓取（使用 reqwest），并实现一个持久化磁盘缓存 (./image_cache 目录)。后端通过 SHA256 哈希 URL，将图片数据 (.data) 和元数据(Content-Type, .meta) 分别存储在磁盘上。这不仅解决了前端访问限制问题，而且通过持久化缓存，确保了即使在服务重启后，图片也无需重新抓取，极大地提升了效率。

开发体验: 使用 cargo-watch 实现了热重载，修改 Rust 代码后服务会自动重启。

packages/frontend (前端界面)

技术: Vite, SolidJS, TypeScript

职责:

数据可视化: 连接到后端的 Socket.IO 服务，接收实时数据，并以表格形式高效地渲染出来。

配置透明化: 启动时从后端获取当前正在监控的 DESIRED_FIELDS 列表并在页面上展示，使用户清楚地了解数据范围。

极致性能: SolidJS 无虚拟 DOM 的架构确保了即使在高频数据更新下，页面也能保持流畅。

开发体验: Vite 提供了顶级的热模块替换（HMR）功能，修改任何前端代码，浏览器都会瞬时响应，无需刷新。

packages/shared-types (共享类型与配置)

技术: TypeScript

职责: 定义了 frontend 和 extractor 之间共享的 TypeScript 类型、接口以及类似 DESIRED_FIELDS 的静态配置。同时，它也定义了 API 契约，例如 Socket.IO 事件名 (如 data-update) 和 API 路由 (如 /desired-fields)，确保了 Rust 后端与 TypeScript 前/后端之间的通信规范。