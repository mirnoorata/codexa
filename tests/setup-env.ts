import { beforeEach } from "vitest";

beforeEach(() => {
  delete process.env.CODEXA_WORKSPACE_SESSION;
  delete process.env.CODEXA_WORKSPACE_FOCUS_FILE;
  // Ordinary tests must never inherit a developer's hosted-scoring opt-in/key.
  for (const name of ["TYPESAFE_API_KEY", "CODEXA_TYPESAFE", "CODEXA_TYPESAFE_MODEL", "CODEXA_TYPESAFE_TIMEOUT_MS", "CODEXA_TYPESAFE_MAX_CANDIDATES"]) {
    delete process.env[name];
  }
});
