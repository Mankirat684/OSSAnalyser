import { fromA } from "./a.js";

export function fromB(): string {
  // This function is intentionally not called; the import cycle is for graph testing.
  let a = 5;
  let b = 9;
  console.log(a+b);
  return fromA.name;

}
