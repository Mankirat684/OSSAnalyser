/**
 * Regression Test Fixture for TypeScript syntax constructs:
 * 1. Generic arrow functions with type parameters (<T>)
 * 2. Cast declarations ((...) => ...) as Type
 * 3. Typed variable assignments const fn: Type = ...
 */

export interface StoreApi<T> {
  getState: () => T;
  setState: (fn: (prev: T) => T) => void;
}

export type CreateStore = <T>(initializer: () => T) => StoreApi<T>;

export const createStore = ((initializer) => {
  let state = initializer ? initializer() : ({} as any);
  return {
    getState: () => state,
    setState: (fn: any) => {
      state = fn(state);
    }
  };
}) as CreateStore;

export const createGenericPipeline = <T, R>(processor: (item: T) => R) => {
  return (input: T): R => {
    return processor(input);
  };
};

export type ActionHandler = (payload: Record<string, unknown>) => boolean;

export const handleAction: ActionHandler = (payload) => {
  return Object.keys(payload).length > 0;
};
