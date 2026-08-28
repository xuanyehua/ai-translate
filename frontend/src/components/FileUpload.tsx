import { useRef, useState } from 'react'
import type { ChangeEvent, DragEvent } from 'react'

export type UploadState = 'pending' | 'uploading' | 'failed'

export interface PendingUpload {
  id: string
  file: File
  state: UploadState
  error?: string
}

interface Props {
  files: PendingUpload[]
  disabled?: boolean
  onAdd: (files: File[]) => void
  onRemove: (id: string) => void
  onClear: () => void
}

export function FileUpload({ files, disabled, onAdd, onRemove, onClear }: Props) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const addFiles = (list: FileList | null) => {
    if (list?.length) onAdd(Array.from(list))
    if (inputRef.current) inputRef.current.value = ''
  }

  const handleDrop = (event: DragEvent) => {
    event.preventDefault()
    setDragging(false)
    addFiles(event.dataTransfer.files)
  }

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => addFiles(event.target.files)

  return (
    <div className="space-y-3">
      <div
        onDragOver={event => { event.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => !disabled && inputRef.current?.click()}
        className={`border-2 border-dashed rounded-2xl p-8 text-center transition-all ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'} ${dragging ? 'border-violet-500 bg-violet-50 dark:bg-violet-900/20' : 'border-slate-300 dark:border-slate-600 hover:border-violet-400 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}
      >
        <input ref={inputRef} type="file" multiple disabled={disabled} accept=".pdf,.docx,.pptx,.xlsx,.md,.png,.jpg,.jpeg,.bmp,.tiff,.webp,.gif" onChange={handleChange} className="hidden" />
        <div className="space-y-2">
          <div className="w-11 h-11 mx-auto rounded-xl bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center text-violet-600 text-xl">↑</div>
          <p className="text-sm font-medium text-slate-700 dark:text-slate-300">拖拽文件到此处，或 <span className="text-violet-600 dark:text-violet-400">点击选择</span></p>
          <p className="text-xs text-slate-500">支持文档和图片，单次最多 10 个文件</p>
        </div>
      </div>

      {files.length > 0 && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 divide-y divide-slate-100 dark:divide-slate-700">
          <div className="px-4 py-2.5 flex items-center justify-between">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-200">待上传 {files.length}/10</span>
            <button type="button" disabled={disabled} onClick={onClear} className="text-xs text-slate-500 hover:text-red-500 disabled:opacity-40">清空</button>
          </div>
          {files.map(item => (
            <div key={item.id} className="px-4 py-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-slate-800 dark:text-slate-100 truncate">{item.file.name}</p>
                <p className={`text-xs ${item.state === 'failed' ? 'text-red-500' : 'text-slate-500'}`}>
                  {item.state === 'uploading' ? '正在上传…' : item.state === 'failed' ? item.error || '上传失败' : `${(item.file.size / 1024).toFixed(1)} KB`}
                </p>
              </div>
              {item.state === 'uploading' ? <span className="w-4 h-4 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" /> : <button type="button" onClick={() => onRemove(item.id)} className="text-xs text-slate-500 hover:text-red-500">移除</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
