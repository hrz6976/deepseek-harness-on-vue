import type { Annotation } from '@/shared/page-protocol';

export function canSubmitPageMessage(text: string, annotations: readonly Annotation[]): boolean {
  return text.trim().length > 0 || annotations.length > 0;
}

export function takeAnnotationSubmission(annotations: Annotation[]): Annotation[] {
  const submission = annotations.slice();
  annotations.splice(0);
  return submission;
}
