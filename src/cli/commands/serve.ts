import * as path from "node:path";
import { startMcpStdioServer } from "../../mcp/server.js";

export interface ServeOptions {
  repo?: string;
  watch?: boolean;
}

export async function runServeCommand(options: ServeOptions): Promise<void> {
  const repoRoot = path.resolve(options.repo || process.cwd());
  await startMcpStdioServer(repoRoot);
}
