import { Layout } from './components/Layout/Layout'
import { ToastContainer } from './components/Toast/Toast'
import { useMobileDetection } from './hooks/useMediaQuery'

function App() {
  useMobileDetection()

  return (
    <>
      <Layout />
      <ToastContainer />
    </>
  )
}

export default App
