import type { Annotation } from '@/shared/page-protocol';
import type { LlmRequest } from '@/shared/runtime';

const MAX_ANNOTATIONS = 20;

export function canSubmitPageMessage(text: string, annotations: readonly Annotation[]): boolean {
  return text.trim().length > 0 || annotations.length > 0;
}

export function takeAnnotationSubmission(annotations: Annotation[]): Annotation[] {
  const submission = annotations.slice();
  annotations.splice(0);
  return submission;
}

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
  return `The following page annotations were explicitly submitted with this user message. Each annotation text is user intent attached to its target. Answer or act on the annotations even when the typed message is vague; inspect the specified target with page_query only if its fingerprint is insufficient.\n${JSON.stringify(context, null, 2)}`;
}

export function attachAnnotationContext(request: LlmRequest, annotationContext: string): LlmRequest {
  if (!annotationContext) return request;
  const messages = [...request.messages];
  let userIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === 'user') {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return request;
  const user = messages[userIndex]!;
  if (user.role !== 'user') return request;
  messages[userIndex] = {
    ...user,
    text: `${user.text}\n\n--- Submitted page annotations ---\n${annotationContext}`,
  };
  return { ...request, messages };
}
