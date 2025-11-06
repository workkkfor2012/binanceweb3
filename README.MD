# 实时市场数据监控面板 (Real-Time Market Monitor)

![Vite](https://img.shields.io/badge/Vite-5.2.11-blue?logo=vite&logoColor=white)
![SolidJS](https://img.shields.io/badge/SolidJS-1.8.17-blueviolet?logo=solid&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-4.27.0-lightgrey?logo=fastify&logoColor=black)
![Playwright](https://img.shields.io/badge/Playwright-1.44.1-brightgreen?logo=playwright&logoColor=white)
![NPM Workspaces](https://img.shields.io/badge/Architecture-Monorepo-orange)

一个现代化的、高性能的实时数据监控面板。它通过 Playwright 脚本从动态网页中提取数据，经由一个高性能的 Fastify 后端，利用 WebSocket 实时推送给一个用 SolidJS 构建的、响应迅速的前端界面。

[此处应有项目运行的截图，就像你之前发给我的那样]

## 核心架构

本项目采用基于 **NPM Workspaces** 的 **monorepo**（单一代码库）架构，将整个系统解耦为三个独立的、职责分明的包：

1.  **`packages/extractor` (数据提取器)**
    *   **技术**: Playwright + Playwright-Extra
    *   **职责**: 作为一个独立的 Node.js 进程，启动一个带代理的浏览器实例，访问目标网页。通过注入的浏览器脚本，以极高的频率（~1000ms）检测并提取数据变更。一旦有数据更新，立即通过 Socket.IO 将增量数据发送给后端。

2.  **`packages/backend` (后端服务)**
    *   **技术**: Fastify + Socket.IO + Undici
    *   **职责**:
        *   **数据中继站**: 监听来自 `extractor` 的数据更新，并立即将这些数据广播给所有连接的前端客户端。
        *   **图片代理与缓存**: 提供一个 `/image-proxy` 路由。前端请求的外部图片会由后端代为抓取，并加入内存缓存。这解决了前端因网络限制无法直接访问图片的问题，并通过缓存机制确保了每张图片只被实际请求一次，极大地提升了性能和效率。
        *   **开发体验**: 使用 `tsx` 实现了热重载，修改后端代码后服务会自动重启。

3.  **`packages/frontend` (前端界面)**
    *   **技术**: Vite + SolidJS
    *   **职责**:
        *   **数据可视化**: 连接到后端的 Socket.IO 服务，接收实时数据，并以表格形式高效地渲染出来。
        *   **极致性能**: SolidJS 无虚拟 DOM 的架构确保了即使在高频数据更新下，页面也能保持流畅。
        *   **开发体验**: Vite 提供了顶级的热模块替换（HMR）功能，修改任何前端代码，浏览器都会瞬时响应，无需刷新。

### 数据流动图

```
1. 数据提取:
[ Extractor (Playwright) ] --(有代理)--> [ 目标网站 ]

2. 数据实时推送:
[ Extractor ] --(Socket.IO 'data-update')--> [ Backend ] --(Socket.IO 'data-broadcast')--> [ Frontend ]

3. 图片代理:
[ Frontend <img/> ] --(HTTP GET)--> [ Backend /image-proxy ] --(有代理)--> [ 图片服务器 ]
```

## 功能特性

-   **端到端实时**: 从数据提取到前端展示，全链路采用 WebSocket，延迟极低。
-   **现代化技术栈**: 全面拥抱 Vite, SolidJS, Fastify 等现代高性能工具。
-   **顶级开发体验**: 前后端均支持热重载，`concurrently` 一键启动所有服务。
-   **清晰的 Monorepo 结构**: 使用 NPM Workspaces 管理，职责清晰，便于维护和扩展。
-   **智能图片代理**: 内置内存缓存，解决了跨网络访问问题，并优化了加载性能。
-   **健壮的提取器**: 使用 `playwright-extra` 和 stealth 插件，有效规避机器人检测。

## 项目结构

```
.
├── packages/
│   ├── backend/      # Fastify 后端
│   │   ├── src/server.js
│   │   └── package.json
│   ├── extractor/    # Playwright 数据提取器
│   │   ├── browser-script.js
│   │   ├── extractor.js
│   │   ├── ... (辅助脚本)
│   │   └── package.json
│   └── frontend/     # Vite + SolidJS 前端
│       ├── src/
│       │   ├── App.jsx
│       │   ├── index.css
│       │   └── index.jsx
│       ├── index.html
│       ├── package.json
│       └── vite.config.js
└── package.json      # 根 package.json
```

## 安装与运行

#### 1. 先决条件

-   [Node.js](https://nodejs.org/) (v18 或更高版本)
-   NPM (v7 或更高版本，以支持 Workspaces)
-   一个本地正在运行的代理服务 (本项目配置为 HTTP 代理)。
-   一个本地安装的、基于 Chromium 的浏览器 (如 Chrome, Edge)。

#### 2. 安装

```bash
# 克隆项目 (如果是在git上)
# git clone ...
# cd project-folder

# 安装所有依赖
# npm会读取所有package.json并一次性安装
npm install
```

#### 3. 配置

在运行之前，你需要根据你的本地环境修改两个地方：

1.  **配置浏览器路径 (`extractor`)**
    -   打开 `packages/extractor/extractor.js` 文件。
    -   修改 `MY_CHROME_PATH` 常量为你本地 Chromium 浏览器的 `.exe` 文件路径。
        ```javascript
        const MY_CHROME_PATH = 'F:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
        ```

2.  **配置代理服务器地址 (`backend`)**
    -   打开 `packages/backend/src/server.js` 文件。
    -   修改 `proxyAgent` 的 URL 为你本地 HTTP 代理的实际地址和端口。
        ```javascript
        // ！！！请务必确认你的 HTTP 代理端口并在这里修改 ！！！
        const proxyAgent = new ProxyAgent('http://127.0.0.1:1081');
        ```

#### 4. 启动项目

在项目**根目录**下运行以下命令：

```bash
npm run dev:full
```

这个命令会同时启动后端、前端和数据提取器。你的终端会显示三个服务的日志。

-   后端服务运行于: `http://localhost:3001`
-   前端服务运行于: `http://localhost:15173` (或你在 `vite.config.js` 中配置的端口)
-   提取器会启动一个浏览器窗口并开始工作。

打开你的浏览器，访问前端服务地址 (例如 `http://localhost:15173`)，即可看到实时数据面板。

## 可用脚本

-   `npm install`: 安装所有 workspaces 的依赖。
-   `npm run dev:full`: 同时启动后端、前端和提取器，用于完整的端到端开发。
-   `npm run dev`: 只启动后端和前端，不启动提取器，方便纯界面开发。
-   `npm run dev:backend`: 只启动后端开发服务器 (带热重载)。
-   `npm run dev:frontend`: 只启动前端开发服务器 (带热重载)。
-   `npm run start:extractor`: 只启动数据提取脚本。