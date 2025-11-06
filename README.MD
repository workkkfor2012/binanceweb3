// README.MD
# 实时市场数据监控面板 (TypeScript版)

![TypeScript](https://img.shields.io/badge/TypeScript-5.9.3-blue?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-5.3.1-blue?logo=vite&logoColor=white)
![SolidJS](https://img.shields.io/badge/SolidJS-1.8.17-blueviolet?logo=solid&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-4.28.0-lightgrey?logo=fastify&logoColor=black)
![Playwright](https://img.shields.io/badge/Playwright-1.44.1-brightgreen?logo=playwright&logoColor=white)
![pnpm Workspaces](https://img.shields.io/badge/Architecture-Monorepo-orange?logo=pnpm&logoColor=white)

一个现代化的、高性能的实时数据监控面板。项目已全面使用 **TypeScript** 重构，并通过 **pnpm Workspaces** 进行包管理。它通过 Playwright 脚本从动态网页中提取数据，经由一个高性能的 Fastify 后端，利用 WebSocket 实时推送给一个用 SolidJS 构建的、响应迅速的前端界面。



## 核心架构

本项目采用基于 **pnpm Workspaces** 的 **monorepo**（单一代码库）架构，将整个系统解耦为四个独立的、职责分明的包：

1.  **`packages/extractor` (数据提取器)**
    *   **技术**: Playwright-Extra, TypeScript
    *   **职责**: 作为一个独立的 Node.js 进程，启动一个带代理的浏览器实例访问目标网页。通过 `page.addInitScript` 注入一个高效的浏览器脚本，以极高频率（~1000ms）检测并提取数据变更。一旦有数据更新，立即通过 Socket.IO 将增量数据发送给后端。

2.  **`packages/backend` (后端服务)**
    *   **技术**: Fastify, Socket.IO, Undici, TypeScript
    *   **职责**:
        *   **数据中继站**: 监听来自 `extractor` 的数据更新，并立即将这些数据广播给所有连接的前端客户端。
        *   **配置接口**: 提供一个 API 端点，用于向前端暴露当前系统监控的数据字段列表。
        *   **图片代理与缓存**: 提供一个 `/image-proxy` 路由。前端请求的外部图片会由后端代为抓取，并加入内存缓存。这解决了前端因网络限制无法直接访问图片的问题，并通过缓存机制确保了每张图片只被实际请求一次，极大地提升了性能和效率。
        *   **开发体验**: 使用 `tsx` 实现了热重载，修改后端代码后服务会自动重启。

3.  **`packages/frontend` (前端界面)**
    *   **技术**: Vite, SolidJS, TypeScript
    *   **职责**:
        *   **数据可视化**: 连接到后端的 Socket.IO 服务，接收实时数据，并以表格形式高效地渲染出来。
        *   **配置透明化**: 启动时从后端获取当前正在监控的 `DESIRED_FIELDS` 列表并在页面上展示，使用户清楚地了解数据范围。
        *   **极致性能**: SolidJS 无虚拟 DOM 的架构确保了即使在高频数据更新下，页面也能保持流畅。
        *   **开发体验**: Vite 提供了顶级的热模块替换（HMR）功能，修改任何前端代码，浏览器都会瞬时响应，无需刷新。

4.  **`packages/shared-types` (共享类型与配置)**
    *   **技术**: TypeScript
    *   **职责**: 定义整个项目中（后端、前端、提取器）共享的 TypeScript 类型、接口以及类似 `DESIRED_FIELDS` 的静态配置。这确保了跨包通信时的数据结构一致性和类型安全。