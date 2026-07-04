import type { FC, ButtonHTMLAttributes } from 'react'

export type PixelButtonVariant = 'primary' | 'secondary' | 'accent' | 'danger'

interface PixelButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: PixelButtonVariant
}

const variantClass: Record<PixelButtonVariant, string> = {
  primary: 'btn-pixel-primary',
  secondary: 'btn-pixel-secondary',
  accent: 'btn-pixel-accent',
  danger: 'btn-pixel-danger',
}

export const PixelButton: FC<PixelButtonProps> = ({
  variant = 'primary',
  className = '',
  children,
  ...rest
}) => (
  <button
    className={`btn-pixel ${variantClass[variant]} ${className}`}
    {...rest}
  >
    {children}
  </button>
)
