import { useEffect, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useAppStore } from '../../stores/app-store.js'
import {
  BOOT_MIN_MS,
  BOOT_TARGETS,
  approachBootProgress,
  canFinishSplash,
  formatBootPercent
} from '../../lib/boot-progress.js'
import { InkLogo } from './InkLogo.js'

/**
 * 每次冷启动闪屏：上 logo、下混合进度，到 100% 再进工作台。
 */
export function SplashScreen({ onFinished }: { onFinished: () => void }): React.ReactElement {
  const bootTarget = useAppStore((s) => s.bootTarget)
  const booted = useAppStore((s) => s.booted)
  const bootError = useAppStore((s) => s.bootError)
  const [display, setDisplay] = useState(1)
  const startedAt = useRef(Date.now())
  const finishedRef = useRef(false)

  useEffect(() => {
    if (bootError) return
    let frame = 0
    let alive = true
    const tick = (): void => {
      if (!alive || finishedRef.current) return
      const elapsed = Date.now() - startedAt.current
      let target = bootTarget
      if (canFinishSplash(booted, elapsed)) {
        target = BOOT_TARGETS.done
      }
      setDisplay((prev) => {
        const next = approachBootProgress(prev, target)
        if (next >= 100 && !finishedRef.current && booted) {
          finishedRef.current = true
          // 让 100% 先上屏再卸盖
          queueMicrotask(() => {
            if (alive) onFinished()
          })
        }
        return next
      })
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      alive = false
      cancelAnimationFrame(frame)
    }
  }, [bootTarget, booted, bootError, onFinished])

  if (bootError) {
    return (
      <div className="splash-screen" data-testid="splash-screen" data-state="error">
        <InkLogo size={56} animated={false} />
        <p className="splash-screen__title">i-pi-desk</p>
        <div className="splash-screen__error">
          <AlertTriangle size={16} />
          <span>启动失败</span>
        </div>
        <p className="splash-screen__error-msg">{bootError}</p>
      </div>
    )
  }

  const pct = formatBootPercent(display)

  return (
    <div className="splash-screen" data-testid="splash-screen" data-state="loading">
      <InkLogo size={64} animated />
      <p className="splash-screen__title">i-pi-desk</p>
      <div className="splash-screen__track" role="progressbar" aria-valuemin={1} aria-valuemax={100} aria-valuenow={Math.round(display)} aria-label="启动进度">
        <div className="splash-screen__fill" style={{ width: `${Math.min(100, display)}%` }} />
      </div>
      <p className="splash-screen__pct" data-testid="splash-percent">
        {pct}
      </p>
      <p className="splash-screen__hint">{booted ? '即将进入工作台…' : '正在准备…'}</p>
      {/* 最短时长常量挂在 DOM 上便于自测/调试 */}
      <span className="sr-only" data-min-ms={BOOT_MIN_MS} />
    </div>
  )
}
