import type { Annotation } from './page-protocol';
import type { UserMessage } from './runtime';

export function formatAnnotationPayload(annotations: readonly Annotation[]): string {
  if (!annotations.length) return '';
  const context = annotations.map(annotation => ({
    text: annotation.text,
    url: annotation.scope.url,
    target: {
      selector: annotation.target.selector,
      fingerprint: annotation.target.fingerprint,
      ...(annotation.target.rect ? { rect: annotation.target.rect } : {}),
    },
  }));
  return `<page_annotations>${JSON.stringify(context)}</page_annotations>`;
}

export function userMessageTextForModel(message: UserMessage): string {
  const payload = formatAnnotationPayload(message.annotations ?? []);
  return [message.text, payload].filter(Boolean).join('\n\n');
}
