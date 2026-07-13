#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const TIMEOUT_MS = boundedTimeout(process.env.CODEXA_AGENT_AB_MCP_PREFLIGHT_TIMEOUT_MS);
const EXPECTED_SERVER_NAME = "codexa";
const { expectedVersion, resultPath, command, commandArgs } = parseArguments(process.argv.slice(2));

try {
  const observedServerInfo = await preflight(command, commandArgs, expectedVersion);
  writeFileSync(resultPath, `${JSON.stringify({
    schemaVersion: 1,
    expectedServerInfo: { name: EXPECTED_SERVER_NAME, version: expectedVersion },
    observedServerInfo
  })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
} catch (error) {
  console.error(`MCP initialize/tools-list preflight failed: ${safeError(error)}`);
  process.exitCode = 1;
}

async function preflight(command, commandArgs, expectedVersion) {
  const child = spawn(command, commandArgs, {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false
  });
  let stdout = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let closed = false;
  const pending = new Map();
  let fail;
  const failed = new Promise((_, reject) => {
    fail = reject;
  });
  failed.catch(() => {});
  const timeout = setTimeout(() => fail(new Error("timeout")), TIMEOUT_MS);
  timeout.unref?.();

  child.once("error", () => fail(new Error("server process could not start")));
  child.once("close", (code) => {
    closed = true;
    if (pending.size > 0) {
      fail(new Error(`server exited before completing the handshake (code ${String(code)})`));
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > MAX_STDERR_BYTES) {
      fail(new Error("server stderr exceeded the preflight bound"));
    }
  });
  child.stdout.on("data", (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > MAX_STDOUT_BYTES) {
      fail(new Error("server stdout exceeded the preflight bound"));
      return;
    }
    stdout += chunk.toString("utf8");
    while (true) {
      const newline = stdout.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const line = stdout.slice(0, newline).replace(/\r$/u, "");
      stdout = stdout.slice(newline + 1);
      if (line.length === 0) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        fail(new Error("server emitted non-JSON stdout"));
        return;
      }
      if (message?.jsonrpc !== "2.0" || !Number.isInteger(message.id)) {
        continue;
      }
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        waiter(message);
      }
    }
  });

  const request = (id, method, params) => {
    if (closed || !child.stdin.writable) {
      return Promise.reject(new Error("server stdin is unavailable"));
    }
    const response = new Promise((resolve) => pending.set(id, resolve));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return Promise.race([response, failed]);
  };

  try {
    const initialized = await request(1, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "codexa-agent-ab-preflight", version: "1.0.0" }
    });
    if (initialized.error || !initialized.result || typeof initialized.result !== "object") {
      throw new Error("initialize was rejected");
    }
    const observedServerInfo = initialized.result.serverInfo;
    if (
      !observedServerInfo
      || typeof observedServerInfo !== "object"
      || observedServerInfo.name !== EXPECTED_SERVER_NAME
      || observedServerInfo.version !== expectedVersion
    ) {
      throw new Error(`initialize serverInfo did not identify ${EXPECTED_SERVER_NAME}@${expectedVersion}`);
    }
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    const listed = await request(2, "tools/list", {});
    if (
      listed.error
      || !listed.result
      || !Array.isArray(listed.result.tools)
      || listed.result.tools.length === 0
      || listed.result.tools.some((tool) => !tool || typeof tool.name !== "string" || tool.name.length === 0)
    ) {
      throw new Error("tools/list did not return a non-empty tool manifest");
    }
    return { name: observedServerInfo.name, version: observedServerInfo.version };
  } finally {
    clearTimeout(timeout);
    pending.clear();
    child.stdin.end();
    if (!closed) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("close", resolve)),
        new Promise((resolve) => setTimeout(resolve, 500))
      ]);
    }
    if (!closed) {
      child.kill("SIGKILL");
    }
  }
}

function parseArguments(args) {
  if (args[0] !== "--expected-version" || !/^\d+\.\d+\.\d+$/u.test(args[1] ?? "")) {
    console.error("MCP preflight requires --expected-version <stable-semver>");
    process.exit(2);
  }
  if (args[2] !== "--result" || typeof args[3] !== "string" || args[3].length === 0) {
    console.error("MCP preflight requires --result <path>");
    process.exit(2);
  }
  const commandParts = args.slice(4);
  if (commandParts[0] === "--") {
    commandParts.shift();
  }
  if (commandParts.length === 0) {
    console.error("MCP preflight requires a server command");
    process.exit(2);
  }
  return {
    expectedVersion: args[1],
    resultPath: args[3],
    command: commandParts[0],
    commandArgs: commandParts.slice(1)
  };
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\u0000-\u001f\u007f]/gu, " ").slice(0, 300);
}

function boundedTimeout(value) {
  if (value === undefined) {
    return 60_000;
  }
  if (!/^[1-9][0-9]{0,7}$/u.test(value)) {
    throw new Error("invalid CODEXA_AGENT_AB_MCP_PREFLIGHT_TIMEOUT_MS");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 7_200_000) {
    throw new Error("CODEXA_AGENT_AB_MCP_PREFLIGHT_TIMEOUT_MS is outside the bounded range");
  }
  return parsed;
}
