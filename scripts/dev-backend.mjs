/**
 * Run uvicorn from backend/.venv (cross-platform).
 */
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backend = path.join(__dirname, "..", "backend");
const isWin = process.platform === "win32";
const py = path.join(backend, ".venv", isWin ? "Scripts/python.exe" : "bin/python");
const host = "127.0.0.1";
const port = 8000;

if (await isPortOpen(host, port)) {
  console.error(`Backend appears to already be running at http://${host}:${port}.`);
  console.error("Use the existing server, or stop it before running npm run dev:backend again.");
  process.exit(1);
}

const child = spawn(py, ["-m", "uvicorn", "main:app", "--reload", "--host", host, "--port", String(port)], {
  cwd: backend,
  stdio: "inherit",
});

child.on("exit", (code) => process.exit(code ?? 0));

function isPortOpen(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(750, () => {
      socket.destroy();
      resolve(false);
    });
  });
}
