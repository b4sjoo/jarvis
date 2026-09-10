import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";

export type PageResourceState<T> = { data?: T; loading: boolean; error?: string };

// One current key and one in-flight read per resource. A mutation invalidates the
// running read immediately, then coalesces subsequent invalidations into a reread.
export class PageResource<T> {
  private state: PageResourceState<T> = { loading: true };
  private listeners = new Set<() => void>();
  private active = false;
  private request = 0;
  private pending?: Promise<void>;
  private dirty = false;

  constructor(readonly key: string | undefined, private read: () => Promise<T>) {
    if (key === undefined) this.state = { loading: false };
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  snapshot = () => this.state;
  private publish(state: PageResourceState<T>) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
  mount = () => {
    this.active = true;
    void this.refresh();
    return () => {
      this.active = false;
      this.request++;
      this.pending = undefined;
      this.dirty = false;
    };
  };
  refresh = (invalidate = true): Promise<void> => {
    if (!this.active || this.key === undefined) return Promise.resolve();
    if (this.pending) {
      if (invalidate) {
        this.request++;
        this.dirty = true;
        if (!this.state.loading) this.publish({ ...this.state, loading: true, error: undefined });
      }
      return this.pending;
    }
    const identity = ++this.request;
    const owns = () => this.active && identity === this.request;
    if (invalidate || this.state.data === undefined) {
      this.publish({ ...this.state, loading: true, error: undefined });
    }
    const pending = Promise.resolve().then(() => owns() ? this.read() : undefined).then(
      (data) => { if (owns()) this.publish({ data, loading: false }); },
      (reason) => {
        if (owns()) this.publish({ ...this.state, loading: false, error: errorMessage(reason) });
      }
    ).finally(async () => {
      if (this.pending !== pending) return;
      this.pending = undefined;
      if (this.active && this.dirty) {
        this.dirty = false;
        await this.refresh();
      }
    });
    this.pending = pending;
    return pending;
  };
}

export function usePageResource<T>(key: string | undefined, read: () => Promise<T>) {
  // The key contains every query parameter; ordinary parent renders do not read.
  const resource = useMemo(() => new PageResource(key, read), [key]);
  useLayoutEffect(resource.mount, [resource]);
  const state = useSyncExternalStore(resource.subscribe, resource.snapshot);
  return { ...state, refresh: resource.refresh };
}

// A view lifetime distinguishes A -> B -> A. Each operation additionally has its
// own identity, including cancellation/finally after a replacement stream starts.
export function usePageOperation(key: string) {
  const lifetime = useMemo(() => ({ active: false }), [key]);
  const sequence = useRef(0);
  useLayoutEffect(() => {
    lifetime.active = true;
    return () => { lifetime.active = false; };
  }, [lifetime]);
  const begin = useCallback(() => {
    const identity = ++sequence.current;
    return () => lifetime.active && sequence.current === identity;
  }, [lifetime]);
  const isCurrent = useCallback(() => lifetime.active, [lifetime]);
  return { begin, isCurrent };
}

export function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}
