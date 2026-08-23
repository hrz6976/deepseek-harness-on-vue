// Only tolerate sub-pixel/layout rounding at the bottom. This is deliberately
// not a broad "near bottom" zone: once the user scrolls upward, follow mode is
// a sticky opt-out until they deliberately return to the end.
export const DEFAULT_SCROLL_FOLLOW_THRESHOLD = 8;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function distanceFromScrollBottom(metrics: ScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop);
}

export function isNearScrollBottom(
  metrics: ScrollMetrics,
  threshold = DEFAULT_SCROLL_FOLLOW_THRESHOLD,
): boolean {
  return distanceFromScrollBottom(metrics) <= Math.max(0, threshold);
}

export function nextScrollFollowState(input: {
  following: boolean;
  previousScrollTop: number;
  metrics: ScrollMetrics;
  userDriven: boolean;
}): boolean {
  if (!input.userDriven) return input.following;
  if (input.metrics.scrollTop < input.previousScrollTop - 0.5) return false;
  if (!input.following
    && input.metrics.scrollTop > input.previousScrollTop + 0.5
    && isNearScrollBottom(input.metrics)) return true;
  return input.following;
}
