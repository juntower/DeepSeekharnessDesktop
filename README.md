# DeepSeek Harness Desktop

把开源的 [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh)（deepseek-harness，命令行 + 浏览器 Web 管理界面）包装成一个**看起来、用起来都像原生桌面应用**的 Windows 托盘常驻程序。

对普通用户而言，deepseek-harness 原本需要：装 Node、装 CLI、记命令行、手动起服务、自己开浏览器、自己看日志。DeepSeek Harness Desktop 把这些全部收进一个双击即用、开机自启、常驻系统托盘的壳里。

> 状态：核心功能已实现，通过打包版冒烟验证，并可本地产出 NSIS 安装包（`release/*-setup.exe`，约 131 MB）。尚未对外发布。详见 [`docs/VALIDATION.md`](docs/VALIDATION.md)。

---

## 它解决什么问题

| 原始 deepseek-harness | DeepSeek Harness Desktop |
| --- | --- |
| 手工安装 Node + npm 包 | 内置 Node 运行时，首次启动自动下载并校验 dsh |
| 终端里敲 `dsh web` | 托盘菜单一键启动/停止/重启 |
| 外部浏览器打开 `127.0.0.1:3080` | 内置浏览器直接展示，无需外部浏览器 |
| 进程崩了没人管 | 守护 + 指数退避自动重启 + 状态告警 |
| 服务状态看不见 | 托盘图标 + 动画 + 气泡通知 + 告警弹窗 |
| API Key 写在环境变量/配置文件 | `safeStorage` 加密存储，仅经子进程 env 注入 |

---

## 核心职责

### 1. DSH 进程全生命周期管理

- **自动安装**：首次启动用内置 npm 安装 `@deepseek-ai/dsh`，支持 `latest` / `next` / `alpha` 频道或锁定具体版本。
- **启动守护**：以独立子进程运行 `dsh web --no-open --port <port>`，通过 HTTP 健康检查判定就绪。
- **崩溃恢复**：进程异常退出或连续健康检查失败时按策略重启（默认滑动窗口内最多 N 次，超出则进入 `error` 并告警）。
- **幂等与串行**：安装请求串行排队且同版本短路，避免"首次安装"与"定时更新检查"并发下载同一版本。
- **优雅退出**：先发信号、超时后强制结束进程树，应用退出时不留下孤儿 node 进程。

### 2. Web UI 的原生壳

- `BaseWindow` + 两个 `WebContentsView`：顶部 58px **可信外壳**（自定义标题栏 / 状态条，带 preload + IPC）叠加在**不可信内容区**（DSH Web UI，无 preload、无 Node、独立 `persist:dsh-web` 分区）之上。
- **API Key 注入**：密钥经 Electron `safeStorage`（DPAPI）加密落盘，仅在 spawn 子进程时以环境变量形式注入，绝不出现在 URL、日志或渲染进程中。
- **Token 感知**：`dsh web` 启动时会在 stdout 打印带一次性 token 的 loopback 地址；壳捕获该地址并以带 token 的 URL 加载，避免裸 loopback 401。

### 3. 状态可视化与主动提醒

- **托盘图标**：`idle` / `running` / `warning` / `error` 四态，安装·启动·重启·停止过程中播放 3 帧动画。
- **托盘菜单**：实时显示服务状态、Harness 版本、计费网络、可用更新，并提供启动/停止/重启/检查更新/设置/退出。
- **气泡通知**：服务就绪时弹出系统通知，点击回到主窗口。
- **告警弹窗**：独立的告警窗口承载 warning/danger 级别事件（启动失败、服务异常、计费网络、签名校验失败），可带操作按钮。

### 4. 集成能力

- **开机自启**：`app.setLoginItemSettings`，以 `--hidden` 参数后台启动。
- **关闭/最小化到托盘**：两个开关独立控制；托盘常驻，`window-all-closed` 不退出。
- **计费网络检测**：调用 Windows Runtime `NetworkInformation.GetInternetConnectionProfile()`，识别 Fixed/Variable/OverLimit 计费网络并提醒。
- **回收站删除**：`shell.trashItem`，并拒绝相对路径与盘符根目录。
- **注册表/安装路径管理**：写入 `HKCU\\Software\\DeepSeekHarnessDesktop`（InstallPath/Version）与 `deepseek-harness` 协议注册。
- **自定义协议**：`deepseek-harness://open|settings|restart|start`，单实例转发给已运行实例。

### 5. 自动升级与签名校验

- **应用自身**：`electron-updater`（generic feed，默认禁用）；支持校验 Authenticode 发布者指纹。
- **DSH 运行时**：查询 npm registry `dist-tags` 与 semver 比较，安装新版本后自动重启服务；tarball SRI 校验能力已实现（`src/main/platform/signature.ts`），**接入 npm 安装流程仍在待办**。

---

## 快速开始

### 环境要求

- Node.js `^22.19.0 || >=24.0.0`（开发机）
- Windows 10/11 x64（打包目标）
- 打包运行**不需要**用户机器预装 Node —— 运行时已内置

### 安装依赖

```powershell
npm install
```

### 准备内置运行时（首次 / 需要更新内置 Node 时）

```powershell
npm run prepare:runtime
```

下载内置 Node + npm 到 `build/runtime/`（约 100 MB），供打包时随应用分发。

### 开发模式

```powershell
npm run dev
```

### 类型检查与测试

```powershell
npm run typecheck
npm test
```

### 生产构建

```powershell
npm run build        # typecheck + electron-vite build → out/
npm run dist:dir     # 打包免安装目录 → release/win-unpacked/
npm run dist         # 生成 NSIS 安装包 → release/*-setup.exe
```

> 若 `electron-builder` 卡在下载 Electron，请显式指定本地发行版：
> `node node_modules/electron-builder/cli.js --win dir --x64 --config.electronDist=node_modules/electron/dist`

---

## 运行期配置

配置与密钥位于 Electron `userData` 目录（默认 `%APPDATA%\\DeepSeek Harness Desktop`）：

| 文件 | 内容 | 保护方式 |
| --- | --- | --- |
| `settings.json` | 应用与 DSH 运行参数（见 `AppSettings`） | 明文（不含机密） |
| `secrets.json` | DeepSeek / 网关 API Key、Base URL、额外环境变量 | `safeStorage` 加密 |
| `logs/desktop.log` | 结构化运行日志（system / stdout / stderr） | 明文 |
| `runtime/dsh/` | 下载的 dsh 版本与 `current.json` 清单 | 明文 |

常用设置项（`src/shared/contracts.ts` 中的 `AppSettings`）：

```jsonc
{
  "launchAtLogin": true,
  "startMinimized": false,
  "closeToTray": true,
  "minimizeToTray": true,
  "dsh": {
    "managed": true,
    "channel": "latest",          // latest | next | alpha
    "pinnedVersion": null,        // 锁定版本时优先于此
    "preferredPort": 3080,
    "autoInstall": true,
    "autoRestart": true,
    "maxRestarts": 5,
    "restartWindowMinutes": 10,
    "healthIntervalSeconds": 15,
    "startupTimeoutSeconds": 90,
    "gracefulStopSeconds": 8,
    "extraArgs": []
  }
}
```

---

## 项目结构

```
src/
  main/                      Electron 主进程
    index.ts                 入口：单实例锁、协议、boot
    app-controller.ts        业务编排（状态、通知、窗口、菜单动作）
    logger.ts                环形日志缓冲 + 文件落盘
    notifications.ts         气泡 + 告警窗口
    dsh/
      process-manager.ts     DSH 子进程生命周期、健康检查、重启退避
      runtime-manager.ts     运行时安装/清单/环境变量注入
    ipc/                     IPC 注册与鉴权
    platform/                自启、计费网络、注册表、签名校验
    tray/                    托盘图标 + 菜单 + 动画
    update/                  应用更新（electron-updater）/ DSH 更新
    windows/                 主窗口（BaseWindow）与辅助窗口
  preload/index.ts           可信外壳的 contextBridge API
  renderer/
    shell/                   标题栏 + 状态条
    settings/                设置界面
    alert/                   告警弹窗
    service/                 内容区占位/错误页
  shared/contracts.ts        主/渲染共享类型 + IPC 通道常量
build/runtime/               内置 Node + npm（打包时随 extraResources 分发）
resources/                   图标与托盘位图
scripts/                     图标生成、运行时准备
```

---

## 文档

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) —— 进程模型、窗口分层、状态机、IPC 边界
- [`docs/SECURITY.md`](docs/SECURITY.md) —— 信任边界、密钥处理、供应链校验、已知缺口
- [`docs/VALIDATION.md`](docs/VALIDATION.md) —— 已修复缺陷、测试矩阵、打包版冒烟证据

---

## 已知限制 / 路线图

- [ ] dsh tarball SRI 校验接入 npm 安装流程
- [ ] 应用更新 feed 仍为占位地址（`publish.url`），发布前需替换
- [ ] Authenticode 校验路径尚未在**已签名**的发行版上实测
- [ ] 端到端 UI 验证（托盘交互、协议激活、崩溃重启）仍以手工为主
- [ ] 仅 Windows 为一等公民；macOS/Linux 未验证

---

## 许可证

MIT
