import { Layout } from './components/Layout/Layout'
import { ToastContainer } from './components/Toast/Toast'
import { useMobileDetection } from './hooks/useMediaQuery'
import ReactCursorPosition from 'react-cursor-position'

function App() {
  useMobileDetection()

  return (
    <>
      <ReactCursorPosition>
        <Layout />
      </ReactCursorPosition>
      <ToastContainer />
    </>
  )
}

export default App
