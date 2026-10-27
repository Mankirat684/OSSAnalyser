import type { User } from "../models/user.js";

const users: User[] = [
  { id: "u-101", name: "Ada Lovelace", active: true },
  { id: "u-102", name: "Grace Hopper", active: false }
];

export class UserRepository {
  findById(id: string): User | undefined {
    let a = 5;
    let b = 9;
    console.log(a+b)
    return users.find((user) => user.id === id);
  }
}
