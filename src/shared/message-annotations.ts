import type { Annotation } from './page-protocol';
import type { UserMessage } from './runtime';

const MAX_ANNOTATIONS = 20;

export function formatAnnotationContext(annotations: readonly Annotation[]): string {
  if (!annotations.length) return '';
  const context = annotations.slice(-MAX_ANNOTATIONS).map(annotation => ({
    text: annotation.text,
    url: annotation.scope.url,
    target: {
      selector: annotation.target.selector,
      fingerprint: annotation.target.fingerprint,
      ...(annotation.target.rect ? { rect: annotation.target.rect } : {}),
    },
  }));
  return `The following page annotations were explicitly submitted with this user message. Each annotation text is user intent attached to its target; an empty text means the user intentionally attached the target without an extra note. Answer or act on the annotations even when the typed message is vague; inspect the specified target with page_query if its fingerprint is insufficient. For visual, layout, or CSS feedback, inspect the exact affected element and relevant ::before/::after state with page_style_inspect before proposing or applying a change.\n${JSON.stringify(context, null, 2)}`;
}

export function userMessageTextForModel(message: UserMessage): string {
  const context = formatAnnotationContext(message.annotations ?? []);
  return context
    ? `${message.text}\n\n--- Submitted page annotations ---\n${context}`
    : message.text;
}
