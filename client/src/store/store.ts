/**
 * Minimal observable snapshot store: a stable snapshot reference between
 * changes and synchronous listener notification. The DSH renderer binds a
 * store passed through the registration `hooks` compartment to a
 * `use<Name>(selector)` prop, so components never subscribe themselves.
 */
export interface Observable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

export interface Store<T> extends Observable<T> {
  set(next: T | ((current: T) => T)): void
}

export function createStore<T>(initial: T): Store<T> {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(next) {
      const value = typeof next === 'function' ? (next as (current: T) => T)(snapshot) : next
      if (Object.is(value, snapshot)) return
      snapshot = value
      for (const listener of [...listeners]) listener()
    },
  }
}

/** A selector hook as the renderer hands it to components. */
export type SelectorHook<T> = <R>(selector: (state: T) => R) => R
