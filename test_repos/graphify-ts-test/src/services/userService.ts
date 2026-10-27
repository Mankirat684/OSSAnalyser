import type { User } from "../models/user.js";
import { UserRepository } from "../repositories/userRepository.js";
import { formatUser } from "../utils/format.js";

export class UserService {
  private readonly repository = new UserRepository();

  describeUser(id: string): string {
    const user: User | undefined = this.repository.findById(id);
    if (!user) {
      return `User ${id} not found`;
    }
    return formatUser(user);
  }
}
