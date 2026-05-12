interface Props {
  status: 'uploading' | 'translating'
}

export function Progress({ status }: Props) {
  return (
    <div className="space-y-6">
      <div className="w-16 h-16 mx-auto relative">
        <div className="absolute inset-0 rounded-full border-4 border-slate-200 dark:border-slate-700" />
        <div className="absolute inset-0 rounded-full border-4 border-violet-600 border-t-transparent animate-spin" />
      </div>

      <div className="space-y-2">
        <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
          {status === 'uploading' ? '正在解析文档...' : '正在翻译...'}
        </h3>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {status === 'uploading'
            ? '使用 MinerU 提取文档内容'
            : 'AI 正在翻译，请稍候...'}
        </p>
      </div>

      <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2 overflow-hidden">
        <div
          className="h-full bg-violet-600 rounded-full animate-pulse"
          style={{ width: status === 'uploading' ? '30%' : '70%', transition: 'width 0.5s ease' }}
        />
      </div>
    </div>
  )
}
