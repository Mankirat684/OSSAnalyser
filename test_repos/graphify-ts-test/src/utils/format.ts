import type { User } from "../models/user.js";

export function formatUser(user: User): string {
  const status = user.active ? "active" : "inactive";
  return `${user.name} (${status})`;
}
