import * as React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import WorkerNode from './WorkerNode.tsx' // Import the phone UI!
import './index.css'

// Check the URL bar of whoever is connecting
const currentPath = window.location.pathname;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* The Traffic Switch */}
    {currentPath === '/worker' ? <WorkerNode /> : <App />}
  </React.StrictMode>,
)