import { beforeEach } from "vitest";

beforeEach(() => {
  delete process.env.CODEXA_WORKSPACE_SESSION;
  delete process.env.CODEXA_WORKSPACE_FOCUS_FILE;
});
