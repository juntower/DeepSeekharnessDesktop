# 安全模型

本文说明 DeepSeek Harness Desktop 的信任边界、密钥处理、供应链校验策略，以及当前**已知缺口**。

---

## 1. 信任边界

| 组件 | 信任级别 | 理由 |
| --- | --- | --- |
| Electron 主进程 | 完全可信 | 持有 `safeStorage`、IPC、子进程 spawn 能力 |
| 可信外壳 / 设置 / 告警渲染层 | 可信（受限） | 加载本地打包资源，经 preload 暴露白名单 API |
| DSH Web UI | **不可信** | 是第三方 Web 内容（含 npm 生态的前端代码）；可能被 XSS |
| `@deepseek-ai/dsh` 子进程 | 降权（独立进程） | 以当前用户身份运行，但无 Electron 权限 |
| npm registry / 更新 feed | 外部 | 通过网络获取，需校验 |

设计原则：**内容区永不获得能力**。DSH Web UI 运行在：

- 无 preload 的 `WebContentsView`
- `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`
- 独立 `persist:dsh-web` 会话分区
- 仅允许 loopback 导航；外链走系统浏览器
- 默认拒绝一切权限请求

---

## 2. IPC 防护

每一路 IPC 都经 `secured()` 校验发送方 WebContents id：

```ts
if (!controller.isTrustedWebContents(event.sender.id)) {
  throw new Error('IPC request rejected: untrusted renderer')
}
```

- 只有**可信外壳 / 设置 / 告警**视图的 id 在信任列表内；DSH 内容区即便能发起 IPC 也被拒绝。
- 参数做类型校验（`assertRecord` / `assertString`）与枚举白名单（`WINDOW_ACTIONS` / `OPEN_ACTIONS`），非法值直接抛错。
- `ipcMain.removeHandler` 先于 `handle` 注册，避免重复注册。
- 渲染层通过 `contextBridge` 拿到的是打包好的函数对象，**不是** `ipcRenderer`，无法指定任意 channel。

---

## 3. 密钥处理

| 环节 | 处理 |
| --- | --- |
| 落盘 | `safeStorage.encryptString` → Windows DPAPI，与当前用户账户绑定 |
| 存储文件 | `userData/secrets.json`，内容为 `{ version, encrypted, payload }`（base64） |
| 明文暴露面 | 仅主进程内存；`settingsView()` 只回传 `has*ApiKey` 布尔标志与 Base URL |
| 传递给 dsh | **仅**经子进程 `env` 注入，绝不出现在命令行参数、URL、日志或渲染进程 |
| 日志 | 不记录密钥值 |

`buildEnvironment()` 额外防护：

- 只接受合法环境变量名；
- 显式排除 `NODE_OPTIONS`（防任意代码注入）与 `DSH_DESKTOP_*`（防自我干扰）。

> 注意：DPAPI 保护的是“其他用户/离线窃取”，不能防御已在同一用户会话中运行的恶意软件。

---

## 4. 子进程启动

- `spawn` 使用 `shell: false`，参数以数组传递（避免 shell 注入）。
- `windowsHide: true`，`stdio` 显式 `['ignore','pipe','pipe']`。
- 工作目录固定为安装的 dsh `projectDir`。
- 可执行文件为**内置 node**（`resources/runtime/node/node.exe`），不依赖系统 PATH 中的 node。
- `extraArgs` 来自用户设置，是**用户自担风险**的逃生舱，不参与任何安全校验。

---

## 5. 供应链与更新校验

### 已实现

| 能力 | 状态 |
| --- | --- |
| 应用更新签名校验（`verifyUpdateCodeSignature` + 发布者指纹） | ✅ 已配置 |
| Authenticode 指纹比对（`verifyAuthenticode`） | ✅ 已实现，启动时对 `process.execPath` 校验（需配置指纹） |
| npm tarball SRI 校验（`verifySRI`） | ⚠️ 已实现但**未接入**安装流程 |
| 更新 feed URL | ⚠️ 仍为占位地址 |

### 缺口与建议

1. **接入 SRI**：`DshRuntimeManager` 安装 dsh 时，先用 npm registry 返回的 `dist.integrity` 校验 tarball，再解包。
2. **固定发布指纹**：在 `security.windowsPublisherThumbprint` 中配置真实签名指纹，否则签名校验形同虚设。
3. **替换更新 feed**：`build.publish.url` 目前是 `https://example.invalid/...`，发布前必须替换为真实 HTTPS 源。
4. **锁定版本**：生产环境可将 `dsh.pinnedVersion` 设为经审计的具体版本，避免 `latest` 漂移。

---

## 6. 其他防护

| 场景 | 措施 |
| --- | --- |
| 回收站删除 | 拒绝相对路径与盘符根目录 |
| 外部链接 | `shell.openExternal`，且校验为 http/https |
| 单实例 | `requestSingleInstanceLock`，避免多实例竞争同一端口/同一运行时目录 |
| 配置写入 | 临时文件 + `rename` 原子替换，防写坏 |
| 启动失败可观测 | `uncaughtException` / `unhandledRejection` → `reportFatal()` → 错误弹窗（否则进程会静默无界面） |

---

## 7. 报告漏洞

如发现安全问题，请**不要**公开提交 issue，先通过私有渠道联系维护者。
