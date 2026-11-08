import type { ReactElement, ReactNode } from 'react'

export interface LayoutProps {
  children: ReactNode
}

export default function Layout({ children }: LayoutProps): ReactElement {
  return (
    <div>
      <header>Shared layout</header>
      {children}
    </div>
  )
}
