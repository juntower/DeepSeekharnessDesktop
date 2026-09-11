import '../theme.css'
import './styles.css'
import type {
  AppSettings,
  DesktopSnapshot,
  DshPhase,
  NetworkCost,
  SettingsView,
  UpdateSecretInput,
  UpdateState
} from '../../shared/contracts'

type SettingElement = HTMLInputElement | HTMLSelectElement
type SecretElement = HTMLInputElement | HTMLTextAreaElement

const phaseLabels: Record<DshPhase, string> = {
  idle: '未启动',
  installing: '部署运行时',
  starting: '点火中',
  running: '运行中',
  degraded: '链路抖动',
  restarting: '自动重启',
  stopping: '停机中',
  stopped: '已停止',
  crashed: '进程崩溃',
  error: '故障'
}

const updateLabels: Record<UpdateState['phase'], string> = {
  idle: '尚未检查',
  checking: '检查中',
  available: '发现新版本',
  downloading: '下载中',
  downloaded: '等待安装',
  current: '已是最新',
  disabled: '未配置',
  error: '检查失败'
}

const settingElements = Array.from(document.querySelectorAll<SettingElement>('[data-setting]'))
const secretElements = Array.from(document.querySelectorAll<SecretElement>('[data-secret-setting]'))

let settingsView: SettingsView | null = null
let snapshot: DesktopSnapshot | null = null
let busy = false
let feedbackTimer: number | null = null

function element<T extends HTMLElement>(role: string): T {
  const found = document.querySelector<T>('[data-role="' + role + '"]')
  if (found === null) throw new Error('missing settings element: ' + role)
  return found
}

function settingElement(path: string): SettingElement {
  const found = settingElements.find((candidate) => candidate.dataset.setting === path)
  if (found === undefined) throw new Error('missing setting field: ' + path)
  return found
}

function secretElement(path: string): SecretElement {
  const found = secretElements.find((candidate) => candidate.dataset.secretSetting === path)
  if (found === undefined) throw new Error('missing secret field: ' + path)
  return found
}

function valueAtPath(root: unknown, path: string): unknown {
  let current: unknown = root
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function assignAtPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.')
  let cursor = root
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    if (key === undefined) return
    if (index === keys.length - 1) {
      cursor[key] = value
      return
    }
    const next = cursor[key]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      const replacement: Record<string, unknown> = {}
      cursor[key] = replacement
      cursor = replacement
    } else {
      cursor = next as Record<string, unknown>
    }
  }
}

function readSettingValue(field: SettingElement, path: string): unknown {
  if (field instanceof HTMLInputElement && field.type === 'checkbox') return field.checked
  if (field instanceof HTMLInputElement && field.type === 'number') return Number(field.value)
  if (path === 'dsh.extraArgs') {
    return field.value.trim() === '' ? [] : field.value.trim().split(/\s+/u)
  }
  return field.value.trim()
}

function renderSettingValues(view: SettingsView): void {
  for (const field of settingElements) {
    const path = field.dataset.setting
    if (path === undefined) continue
    const value = valueAtPath(view.settings, path)
    if (field instanceof HTMLInputElement && field.type === 'checkbox') {
      field.checked = value === true
    } else if (Array.isArray(value)) {
      field.value = value.join(' ')
    } else {
      field.value = value === null || value === undefined ? '' : String(value)
    }
  }
}

function renderSecretValues(view: SettingsView): void {
  secretElement('deepseekBaseUrl').value = view.secrets.deepseekBaseUrl
  secretElement('gatewayBaseUrl').value = view.secrets.gatewayBaseUrl
  secretElement('gatewayModel').value = view.secrets.gatewayModel
  secretElement('extraEnvironment').value = Object.keys(view.secrets.extraEnvironment).length === 0
    ? ''
    : JSON.stringify(view.secrets.extraEnvironment, null, 2)
  const deepseekKey = settingElement('deepseekApiKey')
  const gatewayKey = settingElement('gatewayApiKey')
  if (deepseekKey instanceof HTMLInputElement) deepseekKey.value = ''
  if (gatewayKey instanceof HTMLInputElement) gatewayKey.value = ''
  element('deepseek-key-state').textContent = view.secrets.hasDeepseekApiKey ? '已配置' : '未配置'
  element('gateway-key-state').textContent = view.secrets.hasGatewayApiKey ? '已配置' : '未配置'
}

function networkLabel(cost: NetworkCost, interfaceName: string | null): string {
  if (cost === 'metered') return interfaceName === null ? '计费网络' : '计费 · ' + interfaceName
  if (cost === 'unrestricted') return '非计费'
  return '未知'
}

function formatTime(value: string | null): string {
  if (value === null) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function renderSnapshot(value: DesktopSnapshot): void {
  snapshot = value
  element('phase').textContent = phaseLabels[value.dsh.phase]
  element('phase-message').textContent = value.dsh.message
  element('port').textContent = value.dsh.port === null ? '—' : String(value.dsh.port)
  element('pid').textContent = value.dsh.pid === null ? '—' : String(value.dsh.pid)
  element('network').textContent = networkLabel(value.network.cost, value.network.interfaceName)
  element('app-update').textContent = updateLabels[value.update.phase]
  element('dsh-update').textContent = updateLabels[value.dshUpdate.phase]
  element('app-update-detail').textContent = value.update.message
  element('dsh-update-detail').textContent = value.dshUpdate.message
  element('runtime-version').textContent = value.dsh.runtime?.version ?? '未安装'
  element('runtime-version-sidebar').textContent = value.dsh.runtime?.version ?? '—'
  element('runtime-channel').textContent = value.dsh.runtime?.channel ?? '—'
  element('runtime-installed').textContent = formatTime(value.dsh.runtime?.installedAt ?? null)
  element('runtime-path').textContent = value.dsh.runtime?.projectDir ?? '—'
  element('install-path').textContent = value.installPath
  element('user-data-path').textContent = value.userDataPath
  element('app-version').textContent = value.appVersion
  element('status-summary').textContent = phaseLabels[value.dsh.phase] + (value.dsh.port === null ? '' : ' · PORT ' + String(value.dsh.port))
  const dot = element('status-dot')
  dot.classList.toggle('is-live', value.dsh.phase === 'running')
  dot.classList.toggle('is-warning', value.dsh.phase === 'degraded' || value.dsh.phase === 'restarting')
  dot.classList.toggle('is-error', value.dsh.phase === 'crashed' || value.dsh.phase === 'error')
  const logs = value.logs.slice(-80).map((entry) => {
    const time = new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false })
    return '[' + time + '] [' + entry.stream.toUpperCase() + '] ' + entry.message
  }).join('\n')
  element('logs').textContent = logs === '' ? '暂无日志。' : logs
}

function renderSettings(view: SettingsView): void {
  settingsView = view
  renderSettingValues(view)
  renderSecretValues(view)
}

function setFeedback(message: string, error = false): void {
  const target = element('feedback')
  target.textContent = message
  target.classList.add('is-visible')
  target.classList.toggle('is-error', error)
  if (feedbackTimer !== null) window.clearTimeout(feedbackTimer)
  feedbackTimer = window.setTimeout(() => {
    target.classList.remove('is-visible', 'is-error')
  }, error ? 8_000 : 4_500)
}

function collectSettings(): AppSettings {
  if (settingsView === null) throw new Error('设置尚未加载')
  const next = structuredClone(settingsView.settings) as unknown as Record<string, unknown>
  for (const field of settingElements) {
    const path = field.dataset.setting
    if (path === undefined) continue
    assignAtPath(next, path, readSettingValue(field, path))
  }
  return next as unknown as AppSettings
}

function collectSecrets(): UpdateSecretInput {
  const deepseekApiKey = settingElement('deepseekApiKey')
  const gatewayApiKey = settingElement('gatewayApiKey')
  const extraEnvironment = secretElement('extraEnvironment').value.trim()
  let environment: Record<string, string> = {}
  if (extraEnvironment !== '') {
    const parsed = JSON.parse(extraEnvironment) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('额外环境变量必须是 JSON 对象')
    }
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof value !== 'string') {
        throw new Error('环境变量名或值无效：' + key)
      }
      environment[key] = value
    }
  }
  const input: UpdateSecretInput = {
    deepseekBaseUrl: secretElement('deepseekBaseUrl').value.trim(),
    gatewayBaseUrl: secretElement('gatewayBaseUrl').value.trim(),
    gatewayModel: secretElement('gatewayModel').value.trim(),
    extraEnvironment: environment
  }
  if (deepseekApiKey.value.trim() !== '') input.deepseekApiKey = deepseekApiKey.value.trim()
  if (gatewayApiKey.value.trim() !== '') input.gatewayApiKey = gatewayApiKey.value.trim()
  return input
}

async function withBusy(button: HTMLButtonElement | null, task: () => Promise<void>): Promise<void> {
  if (busy) return
  busy = true
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-action]'))
  for (const item of buttons) item.disabled = true
  button?.setAttribute('data-running', 'true')
  try {
    await task()
  } catch (error) {
    setFeedback(error instanceof Error ? error.message : String(error), true)
  } finally {
    busy = false
    for (const item of buttons) item.disabled = false
    button?.removeAttribute('data-running')
  }
}

async function refreshAll(): Promise<void> {
  const [view, state] = await Promise.all([window.desktop.getSettings(), window.desktop.getSnapshot()])
  renderSettings(view)
  renderSnapshot(state)
}

async function runAction(action: string, button: HTMLButtonElement | null): Promise<void> {
  switch (action) {
    case 'refresh':
      await withBusy(button, async () => { await refreshAll(); setFeedback('状态已刷新') })
      return
    case 'save-settings':
      await withBusy(button, async () => {
        const view = await window.desktop.patchSettings(collectSettings())
        renderSettings(view)
        setFeedback('设置已保存')
      })
      return
    case 'save-secrets':
      await withBusy(button, async () => {
        const view = await window.desktop.updateSecrets(collectSecrets())
        renderSettings(view)
        setFeedback('连接配置已加密保存')
      })
      return
    case 'clear-deepseek-key':
      await withBusy(button, async () => {
        renderSettings(await window.desktop.updateSecrets({ clearDeepseekApiKey: true }))
        setFeedback('DeepSeek API Key 已清除')
      })
      return
    case 'clear-gateway-key':
      await withBusy(button, async () => {
        renderSettings(await window.desktop.updateSecrets({ clearGatewayApiKey: true }))
        setFeedback('Gateway API Key 已清除')
      })
      return
    case 'start-dsh':
      await withBusy(button, async () => { await window.desktop.startDsh(); await refreshAll(); setFeedback('服务已启动') })
      return
    case 'restart-dsh':
      await withBusy(button, async () => { await window.desktop.restartDsh(); await refreshAll(); setFeedback('服务已重启') })
      return
    case 'stop-dsh':
      await withBusy(button, async () => { await window.desktop.stopDsh(); await refreshAll(); setFeedback('服务已停止') })
      return
    case 'open-external':
      await withBusy(button, async () => { await window.desktop.openDshExternal() })
      return
    case 'check-app-update':
      await withBusy(button, async () => {
        const update = await window.desktop.checkUpdates()
        if (snapshot === null) await refreshAll()
        else renderSnapshot({ ...snapshot, update })
        setFeedback('应用更新检查完成')
      })
      return
    case 'install-app-update':
      await withBusy(button, async () => { await window.desktop.installUpdate(); setFeedback('应用更新已开始安装') })
      return
    case 'check-dsh-update':
      await withBusy(button, async () => {
        const dshUpdate = await window.desktop.checkDshUpdates()
        if (snapshot === null) await refreshAll()
        else renderSnapshot({ ...snapshot, dshUpdate })
        setFeedback('Harness 更新检查完成')
      })
      return
    case 'install-dsh-update':
      await withBusy(button, async () => { await window.desktop.installDshUpdate(); await refreshAll(); setFeedback('Harness 更新安装完成') })
      return
    case 'open-logs':
      await withBusy(button, async () => { await window.desktop.openLogs() })
      return
    case 'check-network':
      await withBusy(button, async () => {
        const network = await window.desktop.checkNetwork()
        if (snapshot !== null) renderSnapshot({ ...snapshot, network })
        setFeedback('计费网络检测完成：' + networkLabel(network.cost, network.interfaceName))
      })
      return
    case 'trash-item': {
      const input = element<HTMLInputElement>('trash-path')
      await withBusy(button, async () => {
        if (input.value.trim() === '') throw new Error('请输入要移入回收站的绝对路径')
        await window.desktop.trashItem(input.value.trim())
        input.value = ''
        setFeedback('目标已移入系统回收站')
      })
      return
    }
  }
}

document.querySelectorAll<HTMLButtonElement>('[data-window]').forEach((button) => {
  button.addEventListener('click', () => {
    const action = button.dataset.window
    if (action === 'minimize' || action === 'maximize' || action === 'close' || action === 'close-to-tray') {
      void window.desktop.windowAction(action).catch((error: unknown) => {
        setFeedback(error instanceof Error ? error.message : String(error), true)
      })
    }
  })
})

document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((button) => {
  button.addEventListener('click', () => { void runAction(button.dataset.action ?? '', button) })
})

window.desktop.onSnapshot(renderSnapshot)
void refreshAll().catch((error: unknown) => {
  setFeedback(error instanceof Error ? error.message : String(error), true)
})
