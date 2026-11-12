import { spawn } from "node:child_process";
import { createServer } from "vite";
import electron from "electron";
import { buildMain } from "./build.mjs";

await buildMain();
const server = await createServer();
await server.listen();
server.printUrls();
const child = spawn(electron, ["."], {
  stdio: "inherit",
  env: { ...process.env, NOVA_DEV_SERVER_URL: "http://127.0.0.1:5173" },
  shell: false,
});
let closing = false;
async function close(exitCode = 0) {
  if (closing) return;
  closing = true;
  child.kill();
  await server.close();
  process.exitCode = exitCode;
}
child.on("error", async (error) => {
  console.error(error.message);
  await close(1);
});
child.on("exit", (code) => void close(code ?? 0));
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
