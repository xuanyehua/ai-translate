import { useEffect, useEffectEvent } from 'react'
import type { TranslationSummary } from './taskTypes'

interface Options {
  onTask: (task: TranslationSummary, completed: boolean) => void
  onReconnect: () => void
}

export function useTaskEvents({ onTask, onReconnect }: Options) {
  const taskHandler = useEffectEvent(onTask)
  const reconnectHandler = useEffectEvent(onReconnect)

  useEffect(() => {
    const source = new EventSource('/api/tasks/events')
    let opened = false
    source.onopen = () => {
      if (opened) reconnectHandler()
      opened = true
    }
    source.addEventListener('task', event => taskHandler(JSON.parse(event.data), false))
    source.addEventListener('completed', event => taskHandler(JSON.parse(event.data), true))
    const syncWhenVisible = () => {
      if (document.visibilityState === 'visible') reconnectHandler()
    }
    document.addEventListener('visibilitychange', syncWhenVisible)
    return () => {
      source.close()
      document.removeEventListener('visibilitychange', syncWhenVisible)
    }
  }, [])
}
