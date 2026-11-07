/** Loads /themes/<name>/theme.css once and resolves when it is applied (or after a timeout). */
export function applyTheme(name: string | undefined): Promise<void> {
  if (!name) return Promise.resolve();
  const id = `theme-${name}`;
  if (document.getElementById(id)) return Promise.resolve();
  return new Promise((resolve) => {
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = `/themes/${encodeURIComponent(name)}/theme.css`;
    const done = () => resolve();
    link.onload = done;
    link.onerror = done;
    setTimeout(done, 3000);
    document.head.appendChild(link);
  });
}
