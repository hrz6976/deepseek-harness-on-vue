/** One controller, deadline and terminal transition for each request. */
export class RequestLifecycle {
  private readonly pending = new Map<string, { controller: AbortController; timer: ReturnType<typeof setTimeout> }>();
  start(id: string, deadline = Date.now() + 30_000): AbortSignal {
    if (this.pending.has(id)) throw new Error(`Duplicate request: ${id}`);
    deadline = Math.min(deadline, Date.now() + 300_000);
    if (deadline <= Date.now()) throw new Error('Request deadline expired.');
    const controller = new AbortController();
    const timer = setTimeout(() => this.cancel(id), deadline - Date.now());
    this.pending.set(id, { controller, timer });
    return controller.signal;
  }
  finish(id: string): void {
    const state = this.pending.get(id);
    if (!state) return;
    clearTimeout(state.timer);
    this.pending.delete(id);
  }
  cancel(id: string): void {
    const controller = this.pending.get(id)?.controller;
    this.finish(id);
    controller?.abort();
  }
  close(): void { for (const id of this.pending.keys()) this.cancel(id); }
}
