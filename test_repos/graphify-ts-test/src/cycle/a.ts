import { fromB } from "./b.js";

export function fromA(): string {
  return `A -> ${fromB()}`;
}
