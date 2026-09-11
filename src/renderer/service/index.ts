import '../theme.css'
import './styles.css'

const phaseCopy: Record<string, { title: string; label: string }> = {
  installing: { title: '正在部署运行时', label: 'INSTALLING' },
  starting: { title: '正在点火启动', label: 'STARTING' },
  restarting: { title: '正在执行自动恢复', label: 'RESTARTING' },
  stopping: { title: '正在安全停机', label: 'STOPPING' },
  error: { title: '本地链路故障', label: 'ERROR' },
  crashed: { title: '运行进程异常退出', label: 'CRASHED' }
}

const params = new URLSearchParams(window.location.search)
const phase = params.get('phase') ?? 'starting'
const message = params.get('message') ?? '正在准备服务运行时…'
const card = document.querySelector<HTMLElement>('.service-card')
const title = document.querySelector<HTMLElement>('[data-role="title"]')
const phaseLabel = document.querySelector<HTMLElement>('[data-role="phase"]')
const messageElement = document.querySelector<HTMLElement>('[data-role="message"]')

if (card !== null) card.dataset.phase = phase
if (title !== null) title.textContent = phaseCopy[phase]?.title ?? '正在建立本地链路'
if (phaseLabel !== null) phaseLabel.textContent = phaseCopy[phase]?.label ?? phase.toUpperCase()
if (messageElement !== null) messageElement.textContent = message
