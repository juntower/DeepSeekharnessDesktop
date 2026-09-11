import '../theme.css'
import './styles.css'
import type { DesktopSnapshot, DshPhase, NetworkCost, UpdateState } from '../../shared/contracts'

const phaseLabels: Record<DshPhase, string> = {
  idle: '未启动',
  installing: '部署运行时',
  starting: '点火中',
  running: '运行中',
  degraded: '链路抖动',
  restarting: '自动重启',
  stopping: '停机关闭',
  stopped: '已停止',
  crashed: '进程崩溃',
  error: '故障'
}

const updateLabels: Record<UpdateState['phase'], string> = {
  idle: '空闲',
  checking: '检查中',
  available: '可升级',
  downloading: '下载中',
  downloaded: '待重启',
  current: '最新',
  disabled: '未配置',
  error: '检查失败'
}

function element<T extends HTMLElement>(role: string): T {
  const found = document.querySelector<T>(`[data-role="${role}"]`)
  if (found === null) throw new Error(`missing shell element: ${role}`)
  return found
}

const phase = element('phase')
const port = element('port')
const version = element('version')
const network = element('network')
const update = element('update')
const lamp = element('lamp')
const errorBar = element('shell-error')

let errorTimer: number | null = null

function showShellError(message: string): void {
  errorBar.textContent = message
  errorBar.classList.add('is-visible')
  if (errorTimer !== null) window.clearTimeout(errorTimer)
  errorTimer = window.setTimeout(() => { errorBar.classList.remove('is-visible') }, 4_500)
}

function networkLabel(cost: NetworkCost, interfaceName: string | null): string {
  if (cost === 'metered') return interfaceName === null ? '计费链路' : `计费 · ${interfaceName}`
  if (cost === 'unrestricted') return '非计费'
  return '未知'
}

function render(snapshot: DesktopSnapshot): void {
  phase.textContent = phaseLabels[snapshot.dsh.phase]
  port.textContent = snapshot.dsh.port === null ? '----' : String(snapshot.dsh.port).padStart(4, '0')
  version.textContent = snapshot.dsh.runtime?.version ?? '未安装'
  network.textContent = networkLabel(snapshot.network.cost, snapshot.network.interfaceName)
  update.textContent = updateLabels[snapshot.dshUpdate.phase === 'available' ? 'available' : snapshot.update.phase]

  document.body.dataset.phase = snapshot.dsh.phase
  document.body.dataset.network = snapshot.network.cost
  lamp.classList.toggle('is-live', snapshot.dsh.phase === 'running')
  lamp.classList.toggle('is-warning', snapshot.dsh.phase === 'degraded' || snapshot.dsh.phase === 'restarting')
  lamp.classList.toggle('is-error', snapshot.dsh.phase === 'crashed' || snapshot.dsh.phase === 'error')
  const tooltip = [
    `DeepSeek Harness ${snapshot.dsh.runtime?.version ?? '未安装'}`,
    snapshot.dsh.message,
    snapshot.dshUpdate.phase === 'available' ? `运行时可更新：${snapshot.dshUpdate.version ?? ''}` : ''
  ].filter(Boolean).join('\n')
  document.getElementById('command-bar')?.setAttribute('title', tooltip)
}

async function invoke(action: () => Promise<unknown>): Promise<void> {
  try {
    await action()
  } catch (error) {
    showShellError(error instanceof Error ? error.message : String(error))
  }
}

document.querySelectorAll<HTMLElement>('[data-window]').forEach((button) => {
  button.addEventListener('click', () => {
    const action = button.dataset.window
    if (action === 'minimize' || action === 'maximize' || action === 'close' || action === 'close-to-tray') {
      void invoke(() => window.desktop.windowAction(action))
    }
  })
})

document.querySelector<HTMLElement>('[data-command="settings"]')?.addEventListener('click', () => {
  void invoke(() => window.desktop.showSettings())
})
document.querySelector<HTMLElement>('[data-command="external"]')?.addEventListener('click', () => {
  void invoke(() => window.desktop.openDshExternal())
})
document.querySelector<HTMLElement>('[data-command="restart"]')?.addEventListener('click', () => {
  void invoke(() => window.desktop.restartDsh())
})

window.desktop.onSnapshot(render)
void window.desktop.getSnapshot().then(render).catch((error: unknown) => {
  showShellError(error instanceof Error ? error.message : String(error))
})