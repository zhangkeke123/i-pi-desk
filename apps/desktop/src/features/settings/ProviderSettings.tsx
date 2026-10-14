import { useEffect, useState } from 'react'
import {
  Bot,
  Brain,
  CheckCircle2,
  ChevronLeft,
  Cloud,
  Cpu,
  Loader2,
  Palette,
  Plus,
  Server,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X,
  XCircle
} from 'lucide-react'
import type { AppSettings, ProviderApiStyle, ProviderConfig, ProviderView } from '@i-pi-desk/shared'
import { useAppStore } from '../../stores/app-store.js'
import { call, getDesk, IpcError } from '../../lib/desk.js'
import {
  COMMON_THINKING_LEVELS,
  normalizeThinkingLevel,
  thinkingHint,
  thinkingLabel
} from '../../lib/thinking.js'
import { McpSection } from './McpSection.js'
import { SubagentsSection } from './SubagentsSection.js'
import { SkillsSection } from '../skills/SkillsSection.js'
import { ThemeGrid } from '../theme/ThemeSwitcher.js'

/**
 * 模型与设置。
 *
 * 设计取向：**把「内网端点」做成一等公民**。
 * 常见私有化场景（Ollama / vLLM / 企业网关）都提供预设，用户只需填 baseUrl 和模型名。
 * 这正是相对上游产品最重要的差异化 —— 他们主打公网 provider 体验，
 * 我们要让「代码不出内网」这条路走起来最顺。
 */

const API_STYLES: Array<{ value: ProviderApiStyle; label: string }> = [
  { value: 'openai-completions', label: 'OpenAI Chat Completions（最常见的兼容协议）' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'google-generative-ai', label: 'Google Generative AI' },
  { value: 'openai-compatible', label: '其它 OpenAI 兼容端点' }
]

interface Preset {
  id: string
  name: string
  hint: string
  build: () => Pick<ProviderConfig, 'label' | 'apiStyle' | 'baseUrl' | 'models'>
}

const PRESETS: Preset[] = [
  {
    id: 'ollama',
    name: 'Ollama（本机）',
    hint: '无需 API Key，模型名填 `ollama list` 里看到的那个',
    build: () => ({
      label: 'Ollama',
      apiStyle: 'openai-completions',
      baseUrl: 'http://localhost:11434/v1',
      models: [{ id: 'qwen2.5-coder:7b' }]
    })
  },
  {
    id: 'vllm',
    name: 'vLLM / 内网网关',
    hint: '任何兼容 OpenAI 协议的内网推理服务',
    build: () => ({
      label: '内网推理服务',
      apiStyle: 'openai-completions',
      baseUrl: 'http://10.0.0.10:8000/v1',
      models: [{ id: 'Qwen3-Coder-30B' }]
    })
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    hint: '官方 API',
    build: () => ({
      label: 'DeepSeek',
      apiStyle: 'openai-completions',
      baseUrl: 'https://api.deepseek.com/v1',
      models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }]
    })
  },
  {
    id: 'openai',
    name: 'OpenAI',
    hint: '官方 API',
    build: () => ({
      label: 'OpenAI',
      apiStyle: 'openai-responses',
      baseUrl: '',
      models: [{ id: 'gpt-5.1' }]
    })
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    hint: '官方 API',
    build: () => ({
      label: 'Anthropic',
      apiStyle: 'anthropic-messages',
      baseUrl: '',
      models: [{ id: 'claude-sonnet-5' }]
    })
  }
]

function emptyDraft(): ProviderConfig {
  return {
    id: crypto.randomUUID(),
    label: '',
    apiStyle: 'openai-completions',
    baseUrl: '',
    models: [],
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
}

/**
 * 权限模式的三档。
 *
 * `label` 是分段控件上显示的短名，`full` 是完整说明 —— 短名是为了三个按钮能并排放，
 * 完整说明进 title 与行说明，一个字都没丢。
 */
const PERMISSION_MODES: Array<{
  value: AppSettings['permissionMode']
  label: string
  full: string
}> = [
  { value: 'readonly', label: '只读', full: '只读（最安全）：一律不写文件、不跑命令' },
  { value: 'ask', label: '每次询问', full: '每次询问（推荐）：每次写文件 / 跑命令前都问你' },
  { value: 'auto', label: '自动放行', full: '自动放行（危险命令仍会问）' }
]

/** 左导航：点选后右侧只展示对应面板（Codex 式分区，不再整页平铺滚动）。 */
const SETTINGS_NAV: Array<{
  group: string
  items: Array<{ id: string; label: string; icon: typeof Settings2 }>
}> = [
  {
    group: '偏好',
    items: [
      { id: 'settings-general', label: '通用', icon: SlidersHorizontal },
      { id: 'settings-ai', label: 'AI', icon: Brain },
      { id: 'settings-appearance', label: '外观', icon: Palette }
    ]
  },
  {
    group: '智能体',
    items: [
      { id: 'settings-providers', label: '模型 provider', icon: Cpu },
      { id: 'settings-skills', label: '技能', icon: Sparkles },
      { id: 'settings-mcp', label: 'MCP', icon: Server },
      { id: 'settings-subagents', label: '子智能体', icon: Bot }
    ]
  }
]

const SETTINGS_TITLES: Record<string, string> = {
  'settings-general': '通用',
  'settings-ai': 'AI',
  'settings-appearance': '外观',
  'settings-providers': '模型 provider',
  'settings-skills': '技能',
  'settings-mcp': 'MCP 服务器',
  'settings-subagents': '子智能体'
}

const DEFAULT_SETTINGS_SECTION = 'settings-general'

export function ProviderSettings({
  onClose,
  settingsSectionId,
  onSettingsSectionChange
}: {
  onClose: () => void
  settingsSectionId?: string
  onSettingsSectionChange?: (sectionId: string) => void
}): React.ReactElement {
  const providers = useAppStore((s) => s.providers)
  const settings = useAppStore((s) => s.settings)
  const info = useAppStore((s) => s.info)
  const saveProvider = useAppStore((s) => s.saveProvider)
  const removeProvider = useAppStore((s) => s.removeProvider)
  const verifyProvider = useAppStore((s) => s.verifyProvider)
  const updateSettings = useAppStore((s) => s.updateSettings)

  const [draft, setDraft] = useState<ProviderConfig | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null)
  /** 左导航的搜索词：过滤的是「设置项名字」，不是内容。 */
  const [navQuery, setNavQuery] = useState('')
  const resolvedSection =
    settingsSectionId && settingsSectionId in SETTINGS_TITLES
      ? settingsSectionId
      : DEFAULT_SETTINGS_SECTION
  const activeSection = resolvedSection
  const activeTitle = SETTINGS_TITLES[activeSection] ?? '设置'

  const goSection = (sectionId: string): void => {
    onSettingsSectionChange?.(sectionId)
  }

  // 已移除的分区（插件 / 控制面）若残留在导航状态，回落到默认页。
  useEffect(() => {
    if (settingsSectionId && !(settingsSectionId in SETTINGS_TITLES)) {
      onSettingsSectionChange?.(DEFAULT_SETTINGS_SECTION)
    }
  }, [settingsSectionId, onSettingsSectionChange])

  // Esc 关闭：桌面应用的肌肉记忆，不做会显得很「网页」。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const startCreate = (preset?: Preset): void => {
    const base = emptyDraft()
    const withPreset = preset ? { ...base, ...preset.build() } : base
    setDraft(withPreset)
    setApiKey('')
    setFeedback(null)
    goSection('settings-providers')
  }

  const startEdit = (provider: ProviderView): void => {
    // 编辑时把 hasApiKey 这种「视图字段」剔掉，别让它被回写到磁盘配置里。
    const { hasApiKey: _hasApiKey, ...rest } = provider
    setDraft(rest)
    setApiKey('')
    setFeedback(null)
    goSection('settings-providers')
  }

  const save = async (): Promise<void> => {
    if (!draft) return
    if (!draft.label.trim()) {
      setFeedback({ ok: false, text: '请填写名称' })
      return
    }
    if (draft.models.length === 0) {
      setFeedback({ ok: false, text: '至少填写一个模型 id' })
      return
    }
    setSaving(true)
    try {
      await saveProvider(draft, apiKey || undefined)
      setDraft(null)
      setApiKey('')
      setFeedback({ ok: true, text: '已保存' })
    } catch (error) {
      setFeedback({ ok: false, text: error instanceof IpcError ? error.message : String(error) })
    } finally {
      setSaving(false)
    }
  }

  const verify = async (): Promise<void> => {
    if (!draft) return
    setSaving(true)
    setFeedback(null)
    try {
      const result = await verifyProvider(draft, apiKey || undefined)
      setFeedback({
        ok: result.ok,
        text: result.ok
          ? `连接成功（${result.checkedBy}${result.models?.length ? `，发现 ${result.models.length} 个模型` : ''}）`
          : `连接失败：${result.message ?? '未知原因'}`
      })
    } catch (error) {
      setFeedback({ ok: false, text: error instanceof IpcError ? error.message : String(error) })
    } finally {
      setSaving(false)
    }
  }

  return (
    /*
      左导航切换面板：右侧只渲染当前分区，避免整页平铺。
      默认「通用」，打开设置时 maxSteps 仍是第一个 number 输入。
    */
    <div data-testid="settings-pane" className="fixed inset-0 z-50 flex flex-col bg-[var(--color-canvas)]">
      <header className="drag flex h-12 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-4">
        {/* 分区切换靠左栏；离开用 × / Esc。历史前进/后退用快捷键，不在顶栏放箭头 */}
        <div className="no-drag flex min-w-0 items-center gap-1.5">
          <Settings2 size={15} className="shrink-0 text-[var(--color-muted)]" />
          <h2 className="text-ui font-medium">设置</h2>
          <span className="truncate text-2xs text-[var(--color-muted)]">/ {activeTitle}</span>
        </div>
        <button type="button" onClick={onClose} className="icon-btn no-drag ml-auto shrink-0" title="关闭设置">
          <X size={15} />
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav
          data-testid="settings-nav"
          className="flex w-[240px] shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]/40"
        >
          <div className="min-h-0 flex-1 overflow-y-auto p-3 pb-2">
            <input
              value={navQuery}
              onChange={(event) => setNavQuery(event.target.value)}
              placeholder="搜索设置…"
              aria-label="搜索设置"
              className="field mb-3 h-8 w-full text-xs"
            />
            {SETTINGS_NAV.map((group) => {
              const items = group.items.filter((item) =>
                item.label.toLowerCase().includes(navQuery.trim().toLowerCase())
              )
              if (items.length === 0) return null
              return (
                <div key={group.group} className="mb-3">
                  <p className="px-2.5 pb-1 pt-0.5 text-[10.5px] font-medium tracking-wide text-[var(--color-muted)]">
                    {group.group}
                  </p>
                  <div className="space-y-0.5">
                    {items.map((item) => {
                      const active = item.id === activeSection
                      return (
                        <button
                          key={item.id}
                          type="button"
                          data-active={active ? 'true' : undefined}
                          aria-current={active ? 'page' : undefined}
                          onClick={() => goSection(item.id)}
                          className={`settings-nav-item flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-2 text-left text-[12.5px] transition-colors ${
                            active
                              ? 'bg-[var(--color-surface-2)] font-medium text-[var(--color-ink)]'
                              : 'text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-2)]/70 hover:text-[var(--color-ink)]'
                          }`}
                        >
                          <item.icon
                            size={14}
                            className={`shrink-0 ${active ? 'text-[var(--color-accent)]' : 'text-[var(--color-muted)]'}`}
                          />
                          <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
          <div className="shrink-0 border-t border-[var(--color-border)] p-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              data-testid="settings-back-to-app"
              className="flex w-full items-center gap-1 rounded-[var(--radius-sm)] px-2 py-2 text-left text-[12.5px] text-[var(--color-ink-soft)] transition-colors hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]"
              title="返回应用"
            >
              <ChevronLeft size={14} className="shrink-0 text-[var(--color-muted)]" />
              返回应用
            </button>
          </div>
        </nav>

        <div data-testid="settings-content" className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl px-7 pb-16 pt-6">
            <h3 className="mb-5 text-[18px] font-semibold tracking-tight text-[var(--color-ink)]">
              {activeTitle}
            </h3>

            {settings && !settings.secretStorageAvailable && activeSection === 'settings-providers' && (
              <div className="mb-4 rounded-[var(--radius-md)] border border-[var(--color-warn)]/40 bg-[var(--color-warn-soft)] p-3 text-xs text-[var(--color-warn)]">
                这台机器没有可用的系统密钥环，<strong>无法安全保存 API Key</strong>。
                你仍然可以使用无需鉴权的内网端点（如 Ollama）。
              </div>
            )}

            {activeSection === 'settings-general' && settings && (
              <GeneralSettings
                settings={settings}
                onUpdate={(patch) => void updateSettings(patch)}
                about={
                  info
                    ? `i-pi-desk ${info.version} · Electron ${info.electron} · Node ${info.node}\n数据目录：${info.userDataPath}`
                    : undefined
                }
              />
            )}

            {activeSection === 'settings-ai' && settings && (
              <AiSettings
                settings={settings}
                onUpdate={(patch) => void updateSettings(patch)}
                onOpenProviders={() => goSection('settings-providers')}
              />
            )}

            {activeSection === 'settings-appearance' && (
              <section id="settings-appearance" className="space-y-3">
                <p className="text-xs text-[var(--color-muted)]">同时作用于面板、终端与原生控件</p>
                <ThemeGrid />
              </section>
            )}

            {activeSection === 'settings-skills' && <SkillsSection />}

            {activeSection === 'settings-mcp' && <McpSection />}

            {activeSection === 'settings-subagents' && <SubagentsSection />}

            {activeSection === 'settings-providers' && (
              <div id="settings-providers">
                {draft ? (
                  <ProviderForm
                    draft={draft}
                    apiKey={apiKey}
                    saving={saving}
                    feedback={feedback}
                    onChange={setDraft}
                    onApiKeyChange={setApiKey}
                    onSave={() => void save()}
                    onVerify={() => void verify()}
                    onCancel={() => {
                      setDraft(null)
                      setFeedback(null)
                    }}
                  />
                ) : (
                  <ProvidersPanel
                    providers={providers}
                    onCreate={startCreate}
                    onEdit={startEdit}
                    onRemove={(id) => void removeProvider(id)}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function ProvidersPanel({
  providers,
  onCreate,
  onEdit,
  onRemove
}: {
  providers: ProviderView[]
  onCreate: (preset?: Preset) => void
  onEdit: (provider: ProviderView) => void
  onRemove: (id: string) => void
}): React.ReactElement {
  return (
    <>
      <div className="mb-4 flex flex-wrap gap-2">
        {PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => onCreate(preset)}
            className="btn btn-outline h-7 px-2.5 text-2xs"
            title={preset.hint}
          >
            + {preset.name}
          </button>
        ))}
        <button
          type="button"
          onClick={() => onCreate()}
          className="btn h-7 border border-dashed border-[var(--color-border-strong)] px-2.5 text-2xs"
        >
          <Plus size={12} />
          自定义
        </button>
      </div>

      {providers.length === 0 ? (
        <p className="py-8 text-center text-ui text-[var(--color-muted)]">
          还没有 provider。选一个预设开始，内网端点推荐用「vLLM / 内网网关」。
        </p>
      ) : (
        <ul className="space-y-2">
          {providers.map((provider) => {
            const managed = provider.source === 'control-plane'
            return (
              <li
                key={provider.id}
                className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-3 transition-colors hover:border-[var(--color-border-strong)]"
              >
                <div className="flex items-center gap-2">
                  <span className="text-ui font-medium">{provider.label}</span>
                  <span className="chip h-[18px] px-1.5 font-mono text-2xs">{provider.apiStyle}</span>
                  {managed && (
                    <span
                      className="chip chip-accent h-[18px] px-1.5 text-2xs"
                      title="由控制面下发；在这里的修改会在下次同步时被覆盖"
                    >
                      <Cloud size={10} />
                      控制面下发
                    </span>
                  )}
                  {provider.hasApiKey && (
                    <span className="chip chip-ok h-[18px] px-1.5 text-2xs">
                      <ShieldCheck size={10} />
                      已存密钥
                    </span>
                  )}
                  <div className="ml-auto flex items-center gap-1">
                    {!managed && (
                      <>
                        <button type="button" onClick={() => onEdit(provider)} className="btn h-6 px-2 text-2xs">
                          编辑
                        </button>
                        <button
                          type="button"
                          onClick={() => onRemove(provider.id)}
                          className="icon-btn h-6 w-6 hover:text-[var(--color-danger)]"
                          title="删除这个 provider"
                        >
                          <Trash2 size={13} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <p className="mt-1 truncate font-mono text-2xs text-[var(--color-muted)]">
                  {provider.baseUrl || '（默认端点）'}
                </p>
                <p className="mt-0.5 truncate text-2xs text-[var(--color-muted)]">
                  {provider.models.map((model) => model.id).join(', ') || '未配置模型'}
                </p>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}

function GeneralSettings({
  settings,
  onUpdate,
  about
}: {
  settings: AppSettings
  onUpdate: (patch: Partial<AppSettings>) => void
  about?: string
}): React.ReactElement {
  const pickDefaultWorkspace = async (): Promise<void> => {
    const path = await call(getDesk().dialog.pickDirectory())
    if (!path) return
    onUpdate({ defaultWorkspacePath: path })
  }

  return (
    <section id="settings-general" className="space-y-5">
      <Row
        label="默认工作空间"
        hint="快捷会话与启动恢复优先使用此目录；安装包也可通过 install-defaults.json 预置"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <p className="truncate font-mono text-2xs text-[var(--color-muted)]" title={settings.defaultWorkspacePath}>
            {settings.defaultWorkspacePath?.trim() || '未设置'}
          </p>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" className="btn btn-outline h-7 px-2.5 text-2xs" onClick={() => void pickDefaultWorkspace()}>
              {settings.defaultWorkspacePath?.trim() ? '更改…' : '选择目录…'}
            </button>
            {settings.defaultWorkspacePath?.trim() ? (
              <button
                type="button"
                className="btn h-7 px-2.5 text-2xs text-[var(--color-muted)]"
                onClick={() => onUpdate({ defaultWorkspacePath: '' })}
              >
                清除
              </button>
            ) : null}
          </div>
        </div>
      </Row>

      <p className="text-xs text-[var(--color-muted)]">
        权限、步数与思考强度已移至左侧「AI」；模型列表在「模型 provider」。
      </p>

      {about && (
        <p className="border-t border-[var(--color-border)] pt-4 font-mono text-2xs leading-relaxed whitespace-pre-line text-[var(--color-muted)]">
          {about}
        </p>
      )}
    </section>
  )
}

function AiSettings({
  settings,
  onUpdate,
  onOpenProviders
}: {
  settings: AppSettings
  onUpdate: (patch: Partial<AppSettings>) => void
  onOpenProviders: () => void
}): React.ReactElement {
  return (
    <section id="settings-ai" className="space-y-5" data-testid="ai-settings">
      <Row label="权限模式" hint="决定 agent 执行写文件 / 跑命令前是否询问">
        <div className="seg" role="radiogroup" aria-label="权限模式">
          {PERMISSION_MODES.map((mode) => {
            const active = settings.permissionMode === mode.value
            return (
              <button
                key={mode.value}
                type="button"
                role="radio"
                aria-checked={active}
                data-testid={`permission-${mode.value}`}
                title={mode.full}
                onClick={() => onUpdate({ permissionMode: mode.value })}
                className={`seg-item ${active ? 'seg-item-active' : ''}`}
              >
                {mode.label}
              </button>
            )
          })}
        </div>
      </Row>

      <Row
        label="思考强度"
        hint={`当前：${thinkingLabel(settings.thinkingLevel)} · ${thinkingHint(settings.thinkingLevel)}`}
      >
        <select
          data-testid="settings-thinking-level"
          aria-label="思考强度"
          value={normalizeThinkingLevel(settings.thinkingLevel) ?? 'medium'}
          onChange={(event) =>
            onUpdate({ thinkingLevel: normalizeThinkingLevel(event.target.value) })
          }
          className="field h-8 min-w-[10rem] text-xs"
        >
          {COMMON_THINKING_LEVELS.map((value) => (
            <option key={value} value={value}>
              {thinkingLabel(value)}
            </option>
          ))}
        </select>
      </Row>

      <Row label="单次最大步数" hint="限制一次任务里工具调用的轮数，防止原地打转">
        <input
          type="number"
          min={1}
          max={200}
          value={settings.maxSteps}
          onChange={(event) => onUpdate({ maxSteps: Number(event.target.value) || 40 })}
          className="field h-7 w-20"
        />
      </Row>

      <Row label="默认模型" hint="Composer 与新会话回落到此默认；可在输入区旁快速切换">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <p className="truncate font-mono text-2xs text-[var(--color-muted)]">
            {settings.defaultProviderId && settings.defaultModelId
              ? `${settings.defaultProviderId} / ${settings.defaultModelId}`
              : '未设置'}
          </p>
          <button
            type="button"
            className="btn btn-outline h-7 w-fit px-2.5 text-2xs"
            onClick={onOpenProviders}
          >
            管理模型 provider →
          </button>
        </div>
      </Row>
    </section>
  )
}

function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="flex items-start gap-3">
      <div className="w-28 shrink-0 pt-1">
        <p className="text-xs">{label}</p>
        {hint && <p className="mt-0.5 text-2xs leading-snug text-[var(--color-muted)]">{hint}</p>}
      </div>
      {children}
    </div>
  )
}

function ProviderForm({
  draft,
  apiKey,
  saving,
  feedback,
  onChange,
  onApiKeyChange,
  onSave,
  onVerify,
  onCancel
}: {
  draft: ProviderConfig
  apiKey: string
  saving: boolean
  feedback: { ok: boolean; text: string } | null
  onChange: (draft: ProviderConfig) => void
  onApiKeyChange: (value: string) => void
  onSave: () => void
  onVerify: () => void
  onCancel: () => void
}): React.ReactElement {
  const modelsText = draft.models.map((model) => model.id).join('\n')

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="text-2xs text-[var(--color-muted)]">名称</span>
        <input
          value={draft.label}
          onChange={(event) => onChange({ ...draft, label: event.target.value })}
          placeholder="例如：公司内网推理服务"
          className="field mt-1 h-8 w-full"
        />
      </label>

      <label className="block">
        <span className="text-2xs text-[var(--color-muted)]">协议</span>
        <select
          value={draft.apiStyle}
          onChange={(event) => onChange({ ...draft, apiStyle: event.target.value as ProviderApiStyle })}
          className="field mt-1 h-8 w-full"
        >
          {API_STYLES.map((style) => (
            <option key={style.value} value={style.value}>
              {style.label}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="text-2xs text-[var(--color-muted)]">
          Base URL <span className="opacity-60">（内网端点必填；官方服务可留空用默认）</span>
        </span>
        <input
          value={draft.baseUrl ?? ''}
          onChange={(event) => onChange({ ...draft, baseUrl: event.target.value })}
          placeholder="http://10.0.0.10:8000/v1"
          className="field mt-1 h-8 w-full font-mono"
        />
      </label>

      <label className="block">
        <span className="text-2xs text-[var(--color-muted)]">
          API Key{' '}
          <span className="opacity-60">
            （{draft.apiKeyRef ? '已保存，留空表示不变更' : '本地无鉴权端点可留空'}）
          </span>
        </span>
        <input
          type="password"
          value={apiKey}
          onChange={(event) => onApiKeyChange(event.target.value)}
          placeholder={draft.apiKeyRef ? '••••••••' : 'sk-...'}
          className="field mt-1 h-8 w-full font-mono"
        />
        <span className="mt-1 block text-2xs text-[var(--color-muted)]">
          密钥由系统密钥环加密保存，只在本机可解；不会写进配置文件明文。
        </span>
      </label>

      <label className="block">
        <span className="text-2xs text-[var(--color-muted)]">模型 id（每行一个）</span>
        <textarea
          value={modelsText}
          onChange={(event) =>
            onChange({
              ...draft,
              models: event.target.value
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean)
                .map((id) => ({ id }))
            })
          }
          rows={4}
          placeholder={'qwen2.5-coder:7b\ndeepseek-chat'}
          className="field mt-1 h-auto w-full resize-y py-1.5 font-mono"
        />
      </label>

      {feedback && (
        <div
          className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs ${
            feedback.ok
              ? 'bg-[var(--color-ok-soft)] text-[var(--color-ok)]'
              : 'bg-[var(--color-danger-soft)] text-[var(--color-danger)]'
          }`}
        >
          {feedback.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
          {feedback.text}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="btn btn-primary h-8"
        >
          {saving && <Loader2 size={12} className="animate-spin" />}
          保存
        </button>
        <button
          type="button"
          onClick={onVerify}
          disabled={saving}
          className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs hover:bg-[var(--color-surface-2)] disabled:opacity-50"
        >
          测试连接
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="ml-auto rounded-md px-3 py-1.5 text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]"
        >
          取消
        </button>
      </div>
    </div>
  )
}
