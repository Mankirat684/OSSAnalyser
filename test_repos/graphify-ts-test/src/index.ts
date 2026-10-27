import { UserService } from "./services/userService.js";

const service = new UserService();
console.log(service.describeUser("u-101"));
