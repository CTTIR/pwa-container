import type { ReactNode } from 'react';

interface Props {
  brand?: string;
  title?: string;
  subtitle?: string;
  footer?: string;
  children: ReactNode;
}

export function Shell({ brand, title, subtitle, footer, children }: Props) {
  return (
    <div className="shell">
      <header className="masthead">
        <div className="masthead-inner">
          {brand && <div className="brand">{brand}</div>}
          {title && <div className="masthead-title">{title}</div>}
          {subtitle && <div className="masthead-subtitle">{subtitle}</div>}
        </div>
      </header>
      <main className="content">{children}</main>
      {footer && <footer className="page-footer">{footer}</footer>}
    </div>
  );
}
