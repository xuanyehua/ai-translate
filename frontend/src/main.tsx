import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

const savedTheme = localStorage.getItem('ai-translate-theme')
const initialDark = savedTheme === 'dark'
  || (savedTheme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
document.documentElement.classList.toggle('dark', initialDark)
document.documentElement.style.colorScheme = savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : 'light dark'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
