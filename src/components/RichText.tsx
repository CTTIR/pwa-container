import { Fragment } from 'react';

/** Renders plain text with **bold** emphasis. No HTML is ever interpreted. */
export function Inline({ text }: { text: string }) {
  const parts = text.split('**');
  return (
    <>
      {parts.map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : <Fragment key={i}>{part}</Fragment>))}
    </>
  );
}

/** The same text without the **emphasis** markers, for aria-label and title attributes. */
export function stripMarkers(text: string): string {
  return text.split('**').join('');
}

export function Paragraphs({ paragraphs, className }: { paragraphs: string[]; className?: string }) {
  return (
    <>
      {paragraphs.map((p, i) => (
        <p key={i} className={className}>
          <Inline text={p} />
        </p>
      ))}
    </>
  );
}
