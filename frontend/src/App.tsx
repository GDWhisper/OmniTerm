import { Layout } from './components/Layout/Layout'
import { ToastContainer } from './components/Toast/Toast'
import { useMobileDetection } from './hooks/useMediaQuery'
import SmartMouse from 'react-smart-mouse'

function App() {
  useMobileDetection()

  return (
    <>
      <Layout />
      <ToastContainer />
      <SmartMouse debug={true} />
    </>
  )
}

export default App
