import { READER_FONT } from '../../utils/fonts'

/** Base button style shared by settings sections (component-adjacent constant —\n *  kept out of component files so react-refresh fast refresh works). */
export const btnBase: React.CSSProperties = {
  background: 'transparent',
  borderWidth: '1px',
  borderStyle: 'solid',
  borderColor: 'var(--border-strong)',
  borderRadius: 0,
  transition: 'all 0.15s ease',
  fontFamily: READER_FONT,
  cursor: 'pointer',
}
