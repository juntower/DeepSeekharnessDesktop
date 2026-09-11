# 架构说明

本文描述 DeepSeek Harness Desktop 的进程模型、窗口分层、状态机与 IPC 边界。所有路径相对于仓库根目录。

---

## 1. 进程模型

```
┌───────────────────────────────────────────────────────────────┐
│ Electron 主进程 (src/main/index.ts)                            │
│                                                               │
│  AppController ──┬── DshProcessManager ── spawn ──▶ node.exe   │
│                  │        │                          │         │
│                  │        └── DshRuntimeManager      └─ dsh web│
│                  │              (内置 npm 安装)       (子进程)  │
│                  ├── TrayController        (托盘图标/菜单)      │
│                  ├── MainWindowController  (BaseWindow + 2 视图)│
│                  ├── AuxiliaryWindows      (设置窗 / 告警窗)    │
│                  ├── NotificationService   (气泡 + 告警)        │
│                  ├── BillingNetworkMonitor (计费网络)           │
│                  ├── RegistryService       (注册表/协议)        │
│                  ├── AppUpdateManager      (electron-updater)   │
│                  └── DshUpdateManager      (npm registry)       │
└───────────────────────────────────────────────────────────────┘
          │ 可信 IPC (contextBridge)          │ HTTP + 一次性 token
          ▼                                   ▼
   shell / settings / alert 渲染进程      DSH Web UI (不可信)
```

**关键点**：DSH 是**独立操作系统进程**，不是 in-process 库。壳只通过 HTTP 与子进程 stdout 交互，因此 dsh 崩溃不会拖垮 Electron 主进程，壳也无需链接 dsh 的任何代码。

### 单实例

`app.requestSingleInstanceLock()` 保证只有一个壳实例。第二个实例的 `second-instance` 事件会把命令行里的 `deepseek-harness://` URL 转发给首个实例，否则只是唤出主窗口。

---

## 2. 窗口分层（不可信内容的隔离）

主窗口用 `BaseWindow` + 两个 `WebContentsView` 手工叠放，而非 `BrowserView` 或 `<webview>`：

```
┌───────────────────────────────────────────────┐
│ shell WebContentsView  (y=0, h=58)            │  ← 可信
│   preload + contextIsolation + sandbox        │    自定义标题栏/状态条
│   nodeIntegration:false                       │    唯一持有 IPC 能力的渲染层
├───────────────────────────────────────────────┤
│ service WebContentsView (y=58, h=height-58)   │  ← 不可信
│   无 preload、无 Node、sandbox:true            │    DSH Web UI
│   partition: 'persist:dsh-web'                │    独立持久化会话
└───────────────────────────────────────────────┘
```

| 视图 | preload | Node | 分区 | 用途 |
| --- | --- | --- | --- | --- |
| shell | ✅ | ❌ | 默认 | 标题栏、状态条、窗口按钮 |
| service | ❌ | ❌ | `persist:dsh-web` | 加载 DSH Web UI |
| settings | ✅ | ❌ | 默认 | 设置界面（独立 BrowserWindow） |
| alert | ✅ | ❌ | 默认 | 告警弹窗（独立 BrowserWindow） |

内容区与信任区**物理隔离在不同 WebContents**，DSH Web UI 即使被 XSS 也无法触达任何 IPC 通道。

`partition: 'persist:dsh-web'` 让 DSH 的登录态/Cookie 独立持久化（`Partitions/dsh-web`），与壳自身会话互不污染。

### 内容区安全策略

- 禁止导航到非 loopback 地址；外部链接一律 `shell.openExternal`。
- 禁止 `window.open` / 新窗口（`setWindowOpenHandler` 拒绝并转外部浏览器）。
- 权限请求（摄像头/通知/地理位置等）默认拒绝。

---

## 3. DSH 状态机

`DshPhase`（`src/shared/contracts.ts`）的状态迁移：

```
idle ──start()──▶ installing ──▶ starting ──健康检查通过──▶ running
                    │               │                        │
                    │               │ 连续健康检查失败        │ 进程退出
                    │               ▼                        ▼
                    │            degraded ──restart()──▶ restarting ──▶ running
                    │                                        │
                    └── 安装/启动失败 ──▶ error              └── 超过重启上限 ──▶ error
                                                              
running/degraded ──stop()──▶ stopping ──▶ stopped
```

| 阶段 | 含义 |
| --- | --- |
| `idle` | 尚未尝试启动 |
| `installing` | 正在准备/安装 dsh 运行时 |
| `starting` | 子进程已 spawn，等待健康检查 |
| `running` | 健康检查通过 |
| `degraded` | 进程存活但连续健康检查失败 |
| `restarting` | 正在重启 |
| `stopping` / `stopped` | 正在停止 / 已停止 |
| `crashed` | 子进程异常退出，等待自动重启 |
| `error` | 启动失败或超过重启配额，需人工介入 |
---

### 就绪判定与 token 捕获

`dsh web` 启动时会在 stdout 打印形如：

```
dsh web: http://127.0.0.1:3080/?token=<token>
```

裸 `http://127.0.0.1:3080/` 会返回 **401**，只有带 token 的 URL 可用。因此：

1. `observeAuthenticatedUrl()` 用正则从 stdout 捕获带 token 的地址，写入 `authUrl`。
2. `waitUntilHealthy()` **优先**用 `authUrl` 探测；20 秒内未捕获到 token 才回退裸地址并记日志。
3. 内容区加载的是带 token 的 URL。

正常就绪返回 **HTTP 303**（重定向到已认证会话）。

### 重启退避

- 滑动窗口（`restartWindowMinutes`）内重启次数超过 `maxRestarts` → 进入 `error` 并告警，不再自动重试。
- 单次重启前有退避延迟；`stopping` 期间不触发守护重启。
- `generation` 计数器标识“当前有效启动尝试”：若一次 `start()` 尚未完成就被 stop/restart 接管，其 `catch` 分支检测到 `generation` 已变，只记日志并正常返回，**不**进入 `error`、**不**弹告警。这消除了“更新期间换运行时”导致的误报启动失败。

---

## 4. 运行时管理（DshRuntimeManager）

安装布局：

```
<userData>/runtime/dsh/
  current.json                      # 当前生效清单
  versions/<requested-version>/     # 每个请求版本一个目录
    node_modules/@deepseek-ai/dsh/
  .staging-<version>-<pid>-<ts>/    # 安装中的临时目录
```

`current.json` 记录 `version / channel / requestedVersion / entry / projectDir / node / installedAt`，`entry` 指向 `.../lib/bin.js`。

### 幂等与串行（防重复下载）

首次启动与定时更新检查存在天然竞态。三个机制解决：

1. **串行队列**：`installChain` 保证同一时刻只有一次 npm 安装；后续请求排队。
2. **同版本短路**：`performInstall()` 开头读 `current.json`，若版本已满足且 `entry` 存在，记 `… is already installed; skipping download` 并立即返回。
3. **更新检查前置**：`DshUpdateManager.check()` 先 `await runtime.installedVersion()`；未安装（返回 null）时直接返回 `idle`，**连网络都不请求**，避免把“正在安装”误判为 0.0.0 → “有更新”。
4. **安装后比对**：`install()` 记录 before/after 版本；一致则返回 `current` 且**不重启服务**。

安装使用**内置 npm**（`resources/runtime/npm`），不依赖用户机器上的 Node/npm。

### 环境变量注入

`buildEnvironment(nodePath, secrets, userDataPath)`：

- 只注入**合法环境变量名**（过滤非法键名）。
- 显式**排除** `NODE_OPTIONS` 与 `DSH_DESKTOP_*` 前缀（防注入/防自我干扰）。
- 把 `secrets` 中的 API Key / Base URL / 网关配置 / 额外环境变量合并进子进程 env。
- 在 `PATH` 前插入内置 node 目录，使 dsh 能解析到正确 node。

---

## 5. 配置与密钥

`SettingsStore` 管理两个文件：

| 文件 | 内容 | 保护 |
| --- | --- | --- |
| `settings.json` | `AppSettings` —— 启动、DSH 守护参数、通知开关、更新 feed、安全指纹 | 明文（不含机密） |
| `secrets.json` | `SecretSettings` —— API Key、Base URL、额外 env | `safeStorage` 加密（Windows 用 DPAPI） |

`settings.json` 写入时逐字段类型校验并夹取范围（`numberValue` 带 min/max），损坏或非法值回退默认。写入走**临时文件 + rename** 原子替换。

---

## 6. IPC 边界

所有 IPC handler 集中在 `src/main/ipc/register.ts`，统一经过 `secured()` 包装：

```ts
if (!controller.isTrustedWebContents(event.sender.id)) {
  throw new Error('IPC request rejected: untrusted renderer')
}
```

`isTrustedWebContents` 只认**可信外壳 / 设置 / 告警**视图的 WebContents id；DSH 内容区即使能发 IPC 也会被拒。参数额外做类型与枚举白名单校验（`assertRecord` / `assertString` / `WINDOW_ACTIONS` / `OPEN_ACTIONS`）。

`preload/index.ts` 通过 `contextBridge` 暴露白名单方法（`DesktopApi`），渲染层拿不到 `ipcRenderer` 本体。

状态推送：主进程 `onSnapshot` → 渲染层订阅 `IPC.stateChanged`，快照包含 `dsh / update / dshUpdate / network / logs`。

---

## 7. 更新

### 应用自身（`AppUpdateManager`）

- 基于 `electron-updater`（**默认导入 + 解构** `autoUpdater`，因为该包是 CJS 且带 lazy getter，ESM 命名导入会在主进程加载期抛错）。
- generic provider；`autoDownload = false`，`autoInstallOnAppQuit = true`。
- feed URL 来自 `updates.appFeedUrl`；为空时状态为 `disabled`。
- 支持 `verifyUpdateCodeSignature` + `windowsPublisherThumbprint` 校验发布者。

### DSH 运行时（`DshUpdateManager`）

- `net.fetch` 拉 `registry.npmjs.org/@deepseek-ai%2Fdsh` 的 `dist-tags`。
- 与 `runtime.installedVersion()` 做 semver 比较；`pinnedVersion` 时用相等判定。
- 安装新版本后 `processManager.restart("updated runtime to <v>")`。

---

## 8. 平台集成

| 能力 | 实现 | 文件 |
| --- | --- | --- |
| 开机自启 | `app.setLoginItemSettings({ openAtLogin, path: execPath, args: ["--hidden"] })` | `platform/auto-launch.ts` |
| 计费网络 | PowerShell 调 WinRT `GetInternetConnectionProfile().GetConnectionCost()`，映射 Fixed/Variable/OverLimit → metered | `platform/billing-network.ts` |
| 注册表 | `reg.exe` 写 `HKCU\Software\DeepSeekHarnessDesktop` + `deepseek-harness` 协议 | `platform/registry.ts` |
| 回收站 | `shell.trashItem`（拒绝相对路径 / 盘符根） | `app-controller.ts` |
| 签名校验 | Authenticode 指纹比对 | `platform/signature.ts` |
| 协议 | `app.setAsDefaultProtocolClient('deepseek-harness')`，`deepseek-harness://open\|settings\|restart\|start` | `main/index.ts` |

---

## 9. 目录约定

| 运行期路径 | 说明 |
| --- | --- |
| `%APPDATA%\DeepSeek Harness Desktop\settings.json` | 应用设置 |
| `…\secrets.json` | 加密密钥 |
| `…\logs\desktop.log` | 运行日志 |
| `…\runtime\dsh\` | 安装的 dsh 版本 |
| `…\Partitions\dsh-web\` | DSH Web UI 会话数据 |
