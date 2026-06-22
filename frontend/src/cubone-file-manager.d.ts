declare module '@cubone/react-file-manager' {
  import type { ComponentType } from 'react'

  interface FileManagerProps {
    files: any[]
    isLoading?: boolean
    height?: string | number
    width?: string | number
    initialPath?: string
    layout?: 'grid' | 'list'
    language?: string
    primaryColor?: string
    fontFamily?: string
    enableFilePreview?: boolean
    collapsibleNav?: boolean
    defaultNavExpanded?: boolean
    fileUploadConfig?: {
      url: string
      method?: string
    }
    onFolderChange?: (path: string) => void
    onCreateFolder?: (name: string, parentFolder: any) => void
    onDelete?: (files: any[]) => void
    onRename?: (file: any, newName: string) => void
    onPaste?: (files: any[], dest: any, op: 'copy' | 'move') => void
    onDownload?: (files: any[]) => void
    onRefresh?: () => void
    onFileUploaded?: (response: any) => void
    onError?: (err: any) => void
  }

  export const FileManager: ComponentType<FileManagerProps>
}
