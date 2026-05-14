import { useState } from 'react'
import type { DragEvent, ChangeEvent } from 'react'

interface Props {
  onFileSelect: (file: File) => void
  inputRef: React.RefObject<HTMLInputElement | null>
}

export function FileUpload({ onFileSelect, inputRef }: Props) {
  const [dragging, setDragging] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) {
      setSelectedFile(file)
      onFileSelect(file)
    }
  }

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      setSelectedFile(file)
      onFileSelect(file)
    }
  }

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      className={`
        relative border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer
        transition-all duration-200
        ${dragging
          ? 'border-violet-500 bg-violet-50 dark:bg-violet-900/20'
          : 'border-slate-300 dark:border-slate-600 hover:border-violet-400 hover:bg-slate-50 dark:hover:bg-slate-800/50'
        }
      `}
      onClick={() => inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.docx,.pptx,.xlsx,.md,.png,.jpg,.jpeg,.bmp,.tiff,.webp,.gif"
        onChange={handleChange}
        className="hidden"
      />

      <div className="space-y-3">
        <div className="w-12 h-12 mx-auto rounded-xl bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center">
          <svg className="w-6 h-6 text-violet-600 dark:text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
          </svg>
        </div>

        {selectedFile ? (
          <div>
            <p className="text-sm font-medium text-slate-900 dark:text-white">{selectedFile.name}</p>
            <p className="text-xs text-slate-500">{(selectedFile.size / 1024).toFixed(1)} KB</p>
          </div>
        ) : (
          <div>
            <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
              拖拽文件到此处，或 <span className="text-violet-600 dark:text-violet-400">点击选择</span>
            </p>
            <p className="text-xs text-slate-500">支持 .pdf .docx .pptx .xlsx .md 及图片</p>
          </div>
        )}
      </div>
    </div>
  )
}
