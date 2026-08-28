/**
 * Monotonic gate for async slicing/export work.
 * Every input invalidation and every newly-started slice advances the generation,
 * so a late response can be recognized without coupling this gate to Web Workers.
 */
export interface SliceGeneration {
  startRequest(): number;
  capture(): number;
  invalidate(): void;
  isCurrent(token: number): boolean;
}

export function createSliceGeneration(): SliceGeneration {
  let generation = 0;

  return {
    startRequest() {
      generation += 1;
      return generation;
    },
    capture() {
      return generation;
    },
    invalidate() {
      generation += 1;
    },
    isCurrent(token) {
      return token === generation;
    },
  };
}
