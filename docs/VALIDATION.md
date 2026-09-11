# 验证记录

本文记录已定位并修复的缺陷、自动化测试矩阵，以及打包版冒烟测试的实测证据。

> 环境：Windows 10.0.26200 / Node v24.15.0 / npm 11.12.1 / Electron 44.3.0

---

## 1. 已修复缺陷

| # | 严重度 | 现象 | 根因 | 修复 |
| --- | --- | --- | --- | --- |
| 1 | 致命 | 打包后启动即闪退，回退到 Electron 默认应用 | `electron-updater` 是 CJS + lazy getter，ESM 命名导入在加载期抛错 | 改为默认导入 + 解构 `autoUpdater` |
| 2 | 高 | 内置 npm 找不到 | 运行时目录嵌套层级与探测逻辑不符 | `prepare-runtime.ps1` 修正布局；`locateBundledNpm()` 探测 3 种布局 |
| 3 | 高 | `dsh web` 启动即崩 | `@deepseek-ai/cordis-plugin-hmr` 需要 `--expose-internals` | spawn 参数加入该 flag |
| 4 | 高 | 内容区裸 loopback 返回 401 | `dsh web` 打印带 token 的 URL，裸地址不可用 | `observeAuthenticatedUrl()` 正则捕获 token URL 并优先用于健康检查与加载 |
| 5 | 高 | 启动失败无任何可见提示 | 早期失败发生在 logger/window 之前 | `reportFatal()` + `dialog.showErrorBox` |
| 6 | 高 | **同一版本被安装两次**（首次启动 vs 定时更新检查竞态） | 更新检查用 `processManager.status.runtime?.version ?? "0.0.0"`，安装中视作 0.0.0 → 误报有更新 → 触发第二次 npm install | `installChain` 串行队列 + 同版本短路 + 更新检查前置 `installedVersion()` + 安装后 before/after 比对 |
| 7 | 中 | 重启竞态误报“启动失败”告警弹窗 | `start()` 的 catch 在 stop/restart 接管后仍置 `error` 并抛错 | catch 检测 `generation` 已变则记日志并正常返回 |
| 8 | 低 | 辅助窗口 `windowIds` 过滤漏掉 `null` | 判据为 `id !== undefined` | 改为 `typeof id === "number"` |

---

## 2. 自动化测试

命令：`npm test`（vitest）。**3 个测试文件 / 18 个用例全部通过。**

| 测试文件 | 用例数 | 覆盖点 |
| --- | --- | --- |
| `src/main/dsh/runtime-manager.test.ts` | 8 | 未安装返回 null；安装并写 manifest；同 channel 复用；**同版本不重下**；换版本重下；**并发同版本只下一次**；**复现原始 bug**（`install(latest)` 与 `install(2.0.0)` 并发只调用一次 npm）；`buildEnvironment` 环境变量净化 |
| `src/main/dsh/process-manager.test.ts` | 3 | token URL 就绪→running→stop 回落 stopped；进程早退→start reject 且 phase `error`；**启动中 restart 不误报** |
| `src/main/utils.test.ts` | 7 | `findAvailablePort` 首选/回退；`probeHttp` 401 视为可达、无监听为失败；`sleep` 正常/已 abort；`errorMessage` |

测试替身：

- `src/main/dsh/__fixtures__/fake-npm-cli.mjs` —— 假 npm，按 `--prefix` 生成 dsh 包结构，支持调用计数/延迟/版本解析。
- `src/main/dsh/__fixtures__/fake-dsh-web.mjs` —— 假 `dsh web`，打印带 token 地址，对 token 返回 303、否则 401。

---

## 3. 打包版冒烟测试

流程：`npm run build` → `electron-builder --win dir` → 启动 `release/win-unpacked/DeepSeek Harness Desktop.exe --user-data-dir=<临时目录> --hidden`。

### 修复前（复现缺陷 6 / 7）

```
00:30:19 Installing @deepseek-ai/dsh@latest …
00:30:34 Alert [info] 发现可用更新: 新版本 0.1.5-rc.1 已可用
00:30:53 Installing @deepseek-ai/dsh@0.1.5-rc.1 …      ← 第二次下载（4 分钟）
00:33:29 DeepSeek Harness 0.1.5-rc.1 installed
00:33:36 DeepSeek Harness 0.1.5-rc.1 installed          ← 重复
00:33:36 Restarting DeepSeek Harness: updated runtime to 0.1.5-rc.1
00:33:36.523 Alert [danger] DeepSeek Harness 启动失败: exited before becoming healthy   ← 误报
00:33:53 health check passed: HTTP 303
```

### 修复后（实测通过）

```
00:56:06 Installing @deepseek-ai/dsh@latest into ...\.staging-latest-33612-...
00:58:22 npm warn deprecated node-domexception@1.0.0
00:58:35 added 519 packages in 2m
00:58:35 DeepSeek Harness 0.1.5-rc.1 installed
00:58:48 dsh web: http://127.0.0.1:3080/?token=***
00:58:49 DeepSeek Harness health check passed: HTTP 303
```

验收结果：

| 检查项 | 期望 | 实测 |
| --- | --- | --- |
| `Installing` 出现次数 | 1 | ✅ 1 |
| 是否存在第二次 `Installing …@0.1.5-rc.1` | 否 | ✅ 无 |
| `installed` 出现次数 | 1 | ✅ 1 |
| 是否有 `Restarting … updated runtime` | 否 | ✅ 无 |
| 是否有 `Alert [danger] … 启动失败` | 否 | ✅ 无 |
| 结尾健康检查 | `HTTP 303` | ✅ |
| 进程树 | 主进程 + 子 node | ✅ 主进程 33612 + node 8520 |
| `Partitions/dsh-web` Cookie 库 | 生成 | ✅ |
| 裸 loopback 探测 | 401 | ✅ 401（token 门控生效） |

证据文件：`smoke-evidence-v1/desktop-prefix.log`（修复前）、`smoke-evidence-v1/desktop-postfix.log`（修复后）。

---

## 4. 静态检查

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| Node 侧类型检查 | `tsc --noEmit -p tsconfig.node.json` | ✅ |
| Web 侧类型检查 | `tsc --noEmit -p tsconfig.web.json` | ✅ |
| 生产构建 | `electron-vite build` | ✅ |
| 打包 | `electron-builder --win dir --x64` | ✅ |

---

## 5. 注册表 / 协议集成（实测）

冒烟运行启动时 `RegistryService.ensureRegistered()` 实际写入 HKCU：

```
HKEY_CURRENT_USER\Software\Classes\deepseek-harness
    URL Protocol    REG_SZ
    (Default)       REG_SZ    URL:DeepSeek Harness Protocol
HKEY_CURRENT_USER\Software\Classes\deepseek-harness\shell\open\command
    (Default)       REG_SZ    "<install>\DeepSeek Harness Desktop.exe" "%1"
HKEY_CURRENT_USER\Software\DeepSeekHarnessDesktop
    InstallPath     REG_SZ    <install>\DeepSeek Harness Desktop.exe
    Version         REG_SZ    1
```

结论：协议注册与安装路径管理按设计工作（`deepseek-harness://open|settings|restart|start`）。

---

## 6. NSIS 安装包

命令：`node node_modules/electron-builder/cli.js --win nsis --x64 --config.electronDist=node_modules/electron/dist`

| 产物 | 大小 |
| --- | --- |
| `release/DeepSeek Harness Desktop-0.1.0-x64-setup.exe` | 131.5 MB |
| `release/DeepSeek Harness Desktop-0.1.0-x64-setup.exe.blockmap` | 0.1 MB |
| `release/latest.yml` | 更新清单（供 electron-updater 使用） |

配置要点：`oneClick:false`（可选安装目录）、创建桌面与开始菜单快捷方式、`runAfterFinish:true`、`deleteAppDataOnUninstall:false`。
---

## 7. 端到端验证（追加）

在打包版上用已有的 `smoke-packaged-data` 用户数据目录复跑，验证运行时复用、单实例锁与崩溃恢复。

### 7.1 运行时复用（无二次下载）

第二次启动同一用户数据目录，日志直接进入启动流程，**没有任何 `Installing` 行**：

```
01:28:17.382 [stdout] dsh web: http://127.0.0.1:3080/?token=***
01:28:17.952 [system] DeepSeek Harness health check passed: HTTP 303
```

→ 已安装版本被正确复用（`ensureRuntime` 命中 manifest + `entry`），启动耗时可忽略下载时间。

### 7.2 单实例锁

在首个实例运行期间再启动一个同参数实例：

```
before=46592,26952,9904,17704,34496
SECOND_PID=41460
second-instance EXITED (single-instance lock OK)
after=46592,26952,9904,17704,34496
```

→ 第二个实例立即退出，首个实例进程树不变。

### 7.3 崩溃自动恢复

强制结束 DSH 子进程（node.exe）后：

```
02:23:08.643 [system] DeepSeek Harness exited with code 4294967295
02:23:08.789 [system] Alert [danger] DeepSeek Harness 服务异常: exited unexpectedly with code 4294967295
02:23:17.841 [stdout] dsh web: http://127.0.0.1:3080/?token=***
02:23:18.409 [system] DeepSeek Harness health check passed: HTTP 303
```

→ 检测到异常退出 → 弹出 danger 告警 → 约 9 秒后自动重启 → 健康检查通过；新 node 子进程（11904）挂回主进程。

证据文件：`smoke-evidence-v1/desktop-e2e.log`。

---

## 8. 尚未覆盖

- [ ] 托盘图标/菜单/动画的交互式验证
- [ ] 关闭/最小化到托盘、单实例唤出（单实例**锁**已在 §7.2 验证）
- [ ] `deepseek-harness://` 协议激活与转发
- [x] 崩溃自动重启（§7.3）；重启配额上限仍待压测
- [ ] 设置界面读写、告警弹窗操作按钮
- [ ] 内置浏览器实际渲染 DSH Web UI（已到 HTTP 303 + 分区生成，未见像素级确认）
- [x] NSIS 安装包已生成（见 §6）；安装后快捷方式/协议注册/开机自启的交互式验证仍待补
- [ ] 已签名版本上的 Authenticode 校验
