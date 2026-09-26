import type { ChangeEvent } from 'react'

export type ThemePreference = 'light' | 'dark' | 'system'

interface Props {
  value: ThemePreference
  onChange: (theme: ThemePreference) => void
}

const THEME_LABELS: Record<ThemePreference, string> = {
  light: '浅色',
  dark: '深色',
  system: '跟随系统',
}

export function ThemeSelector({ value, onChange }: Props) {
  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    onChange(event.target.value as ThemePreference)
  }

  return (
    <label className="relative flex items-center">
      <span className="sr-only">选择界面主题</span>
      <span aria-hidden="true" className="pointer-events-none absolute left-2.5 text-sm">
        {value === 'dark' ? '☾' : value === 'light' ? '☀' : '◐'}
      </span>
      <select
        value={value}
        onChange={handleChange}
        title={`当前主题：${THEME_LABELS[value]}`}
        className="h-9 cursor-pointer appearance-none rounded-lg border border-slate-200 bg-white/80 py-1 pl-8 pr-7 text-sm text-slate-700 outline-none transition-colors hover:bg-slate-100 focus:ring-2 focus:ring-violet-500/40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
      >
        <option value="light">浅色</option>
        <option value="dark">深色</option>
        <option value="system">跟随系统</option>
      </select>
      <span aria-hidden="true" className="pointer-events-none absolute right-2 text-[10px] text-slate-400">▼</span>
    </label>
  )
}
