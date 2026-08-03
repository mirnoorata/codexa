import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compactSessionMemory,
  readSessionMemory,
  recordSessionMemory,
  sessionMemoryCacheDir
} from "../src/session-memory.js";
import { MAX_EVENT_REPLAY_BYTES, type SessionMemoryEvent } from "../src/session-memory/model.js";
import type { SessionMemoryStore } from "../src/types.js";
import { freshnessFixture } from "./session-memory-fixtures.js";

describe("session memory event-log durability", () => {
  it("uses a newer event revision when memory.json is valid but stale", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-valid-stale-"));
    const freshness = freshnessFixture("snap-valid-stale");
    const paths = sessionPaths(repo, "sid-valid-stale");

    await recordSessionMemory({
      repoRoot: repo,
      sessionId: "sid-valid-stale",
      freshness,
      entries: [memoryEntry("decision", "decision:first", "First durable decision.")]
    });
    const staleStore = await readFile(paths.memory, "utf8");

    await recordSessionMemory({
      repoRoot: repo,
      sessionId: "sid-valid-stale",
      freshness,
      entries: [memoryEntry("claim", "claim:second", "Newer event-backed claim.")]
    });
    await writeFile(paths.memory, staleStore, "utf8");

    const recovered = await readSessionMemory({ repoRoot: repo, sessionId: "sid-valid-stale", freshness });
    expect(recovered.revision).toBe(2);
    expect(recovered.memory.entries.map((entry) => entry.summary)).toEqual(
      expect.arrayContaining(["First durable decision.", "Newer event-backed claim."])
    );
    expect(recovered.warnings).toContain(
      "session memory recovered newer event revision 2 over store revision 1; using events.ndjson authority"
    );
  });

  it("treats a newer compact event as a full state replacement", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-compact-replay-"));
    const freshness = freshnessFixture("snap-compact-replay");
    const paths = sessionPaths(repo, "sid-compact-replay");

    await recordSessionMemory({
      repoRoot: repo,
      sessionId: "sid-compact-replay",
      freshness,
      entries: [
        memoryEntry("open_question", "question:active", "Retained active question."),
        { ...memoryEntry("open_question", "question:resolved", "Dropped resolved question."), status: "resolved" }
      ]
    });
    const preCompactionStore = await readFile(paths.memory, "utf8");
    await compactSessionMemory({ repoRoot: repo, sessionId: "sid-compact-replay", freshness });
    await writeFile(paths.memory, preCompactionStore, "utf8");

    const recovered = await readSessionMemory({ repoRoot: repo, sessionId: "sid-compact-replay", freshness });
    expect(recovered.revision).toBe(2);
    expect(recovered.memory.openQuestions.map((entry) => entry.summary)).toEqual(["Retained active question."]);
    expect(recovered.warnings).toContain(
      "session memory recovered newer event revision 2 over store revision 1; using events.ndjson authority"
    );
  });

  it("deduplicates event ids, ignores non-monotonic revisions, and warns on a partial trailing line", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-replay-order-"));
    const freshness = freshnessFixture("snap-replay-order");
    const paths = sessionPaths(repo, "sid-replay-order");

    await recordSessionMemory({
      repoRoot: repo,
      sessionId: "sid-replay-order",
      freshness,
      entries: [memoryEntry("decision", "decision:first", "First ordered event.")]
    });
    await recordSessionMemory({
      repoRoot: repo,
      sessionId: "sid-replay-order",
      freshness,
      entries: [memoryEntry("claim", "claim:second", "Second ordered event.")]
    });
    const [first, second] = await readEvents(paths.events);
    const conflictingDuplicate: SessionMemoryEvent = {
      ...second,
      eventId: first.eventId,
      revision: 99,
      entries: second.entries.map((entry) => ({ ...entry, summary: "Conflicting duplicate must not apply." }))
    };
    const nonMonotonic: SessionMemoryEvent = {
      ...second,
      eventId: "unique-non-monotonic-event",
      revision: 1,
      entries: second.entries.map((entry) => ({ ...entry, summary: "Non-monotonic event must not apply." }))
    };
    await writeFile(
      paths.events,
      [
        JSON.stringify(first),
        JSON.stringify(first),
        JSON.stringify(conflictingDuplicate),
        JSON.stringify(second),
        JSON.stringify(nonMonotonic),
        "{partial"
      ].join("\n"),
      "utf8"
    );
    await writeFile(paths.memory, "{bad json", "utf8");

    const replayed = await readSessionMemory({ repoRoot: repo, sessionId: "sid-replay-order", freshness });
    expect(replayed.revision).toBe(2);
    expect(replayed.memory.claims[0]?.summary).toBe("Second ordered event.");
    expect(replayed.warnings).toContain(`ignored conflicting duplicate session memory event id ${first.eventId}`);
    expect(replayed.warnings).toContain("ignored non-monotonic session memory event revision 1 after revision 2");
    expect(replayed.warnings.some((warning) => warning.startsWith("ignored partial trailing session memory event:"))).toBe(true);
  });

  it("chooses the write-ahead event log and warns when equal revisions diverge", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-equal-divergence-"));
    const freshness = freshnessFixture("snap-equal-divergence");
    const paths = sessionPaths(repo, "sid-equal-divergence");

    await recordSessionMemory({
      repoRoot: repo,
      sessionId: "sid-equal-divergence",
      freshness,
      entries: [memoryEntry("decision", "decision:authority", "Event-log authority value.")]
    });
    const stored = JSON.parse(await readFile(paths.memory, "utf8")) as SessionMemoryStore;
    stored.entries[0] = { ...stored.entries[0], summary: "Divergent memory.json value." };
    await writeFile(paths.memory, `${JSON.stringify(stored, null, 2)}\n`, "utf8");

    const reconciled = await readSessionMemory({ repoRoot: repo, sessionId: "sid-equal-divergence", freshness });
    expect(reconciled.revision).toBe(1);
    expect(reconciled.memory.decisions[0]?.summary).toBe("Event-log authority value.");
    expect(reconciled.warnings).toContain(
      "session memory revision 1 diverges between memory.json and events.ndjson; using events.ndjson write-ahead authority"
    );
  });

  it("keeps a newer valid store when event replay exceeds the byte bound", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-replay-bound-"));
    const freshness = freshnessFixture("snap-replay-bound");
    const paths = sessionPaths(repo, "sid-replay-bound");

    await recordSessionMemory({
      repoRoot: repo,
      sessionId: "sid-replay-bound",
      freshness,
      entries: [memoryEntry("claim", "claim:bounded", "Bounded replay keeps the valid store.")]
    });
    await writeFile(paths.events, "x".repeat(MAX_EVENT_REPLAY_BYTES + 1), "utf8");

    const recalled = await readSessionMemory({ repoRoot: repo, sessionId: "sid-replay-bound", freshness });
    expect(recalled.revision).toBe(1);
    expect(recalled.memory.claims[0]?.summary).toBe("Bounded replay keeps the valid store.");
    expect(recalled.warnings).toContain(
      `session memory replay skipped: events.ndjson exceeds ${MAX_EVENT_REPLAY_BYTES} bytes`
    );
  });

  it("keeps a valid store when the retained delta log starts with a revision gap", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-replay-gap-"));
    const freshness = freshnessFixture("snap-replay-gap");
    const paths = sessionPaths(repo, "sid-replay-gap");

    await recordSessionMemory({
      repoRoot: repo,
      sessionId: "sid-replay-gap",
      freshness,
      entries: [memoryEntry("decision", "decision:first", "First intact store entry.")]
    });
    await recordSessionMemory({
      repoRoot: repo,
      sessionId: "sid-replay-gap",
      freshness,
      entries: [memoryEntry("claim", "claim:second", "Second intact store entry.")]
    });
    const [, second] = await readEvents(paths.events);
    await writeFile(paths.events, `${JSON.stringify(second)}\n`, "utf8");

    const recalled = await readSessionMemory({ repoRoot: repo, sessionId: "sid-replay-gap", freshness });
    expect(recalled.revision).toBe(2);
    expect(recalled.memory.entries.map((entry) => entry.summary)).toEqual(
      expect.arrayContaining(["First intact store entry.", "Second intact store entry."])
    );
    expect(recalled.warnings).toContain("ignored gapped session memory event revision 2; expected 1");
    expect(recalled.warnings).toContain(
      "session memory event delta chain is incomplete; using valid memory.json revision 2"
    );
  });

  it("keeps a newer contiguous replay prefix when only a later event is gapped", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-replay-tail-gap-"));
    const freshness = freshnessFixture("snap-replay-tail-gap");
    const paths = sessionPaths(repo, "sid-replay-tail-gap");

    await recordSessionMemory({
      repoRoot: repo,
      sessionId: "sid-replay-tail-gap",
      freshness,
      entries: [memoryEntry("decision", "decision:first", "First stored revision.")]
    });
    const staleStore = await readFile(paths.memory, "utf8");
    await recordSessionMemory({
      repoRoot: repo,
      sessionId: "sid-replay-tail-gap",
      freshness,
      entries: [memoryEntry("claim", "claim:second", "Second write-ahead revision.")]
    });
    const [first, second] = await readEvents(paths.events);
    const gapped: SessionMemoryEvent = {
      ...second,
      eventId: "gapped-tail-event",
      revision: 4,
      entries: second.entries.map((entry) => ({ ...entry, summary: "Gapped tail must not apply." }))
    };
    await writeFile(
      paths.events,
      `${[first, second, gapped].map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8"
    );
    await writeFile(paths.memory, staleStore, "utf8");

    const recalled = await readSessionMemory({ repoRoot: repo, sessionId: "sid-replay-tail-gap", freshness });
    expect(recalled.revision).toBe(2);
    expect(recalled.memory.entries.map((entry) => entry.summary)).toEqual(
      expect.arrayContaining(["First stored revision.", "Second write-ahead revision."])
    );
    expect(recalled.memory.entries.map((entry) => entry.summary)).not.toContain("Gapped tail must not apply.");
    expect(recalled.warnings).toContain("ignored gapped session memory event revision 4; expected 3");
    expect(recalled.warnings).toContain(
      "session memory recovered newer contiguous event revision 2 over store revision 1; later gapped events were ignored"
    );
  });

  it("keeps equal-revision write-ahead authority despite a later gapped event", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-equal-tail-gap-"));
    const freshness = freshnessFixture("snap-equal-tail-gap");
    const paths = sessionPaths(repo, "sid-equal-tail-gap");

    await recordSessionMemory({
      repoRoot: repo,
      sessionId: "sid-equal-tail-gap",
      freshness,
      entries: [memoryEntry("decision", "decision:first", "Event authority first entry.")]
    });
    await recordSessionMemory({
      repoRoot: repo,
      sessionId: "sid-equal-tail-gap",
      freshness,
      entries: [memoryEntry("claim", "claim:second", "Event authority second entry.")]
    });
    const [first, second] = await readEvents(paths.events);
    const gapped: SessionMemoryEvent = {
      ...second,
      eventId: "equal-revision-gapped-tail",
      revision: 4
    };
    await writeFile(
      paths.events,
      `${[first, second, gapped].map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8"
    );
    const divergent = JSON.parse(await readFile(paths.memory, "utf8")) as SessionMemoryStore;
    divergent.entries[0] = { ...divergent.entries[0], summary: "Divergent store must not win." };
    await writeFile(paths.memory, `${JSON.stringify(divergent, null, 2)}\n`, "utf8");

    const recalled = await readSessionMemory({ repoRoot: repo, sessionId: "sid-equal-tail-gap", freshness });
    expect(recalled.revision).toBe(2);
    expect(recalled.memory.entries.map((entry) => entry.summary)).toContain("Event authority first entry.");
    expect(recalled.memory.entries.map((entry) => entry.summary)).not.toContain("Divergent store must not win.");
    expect(recalled.warnings).toContain(
      "session memory revision 2 diverges between memory.json and events.ndjson; using events.ndjson write-ahead authority"
    );
  });

  it("rejects a fractional store revision and continues from the valid event log", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-invalid-revision-"));
    const freshness = freshnessFixture("snap-invalid-revision");
    const paths = sessionPaths(repo, "sid-invalid-revision");

    await recordSessionMemory({
      repoRoot: repo,
      sessionId: "sid-invalid-revision",
      freshness,
      entries: [memoryEntry("decision", "decision:first", "First valid revision entry.")]
    });
    const malformed = JSON.parse(await readFile(paths.memory, "utf8")) as SessionMemoryStore;
    malformed.revision = 1.5;
    await writeFile(paths.memory, `${JSON.stringify(malformed, null, 2)}\n`, "utf8");

    const recorded = await recordSessionMemory({
      repoRoot: repo,
      sessionId: "sid-invalid-revision",
      freshness,
      entries: [memoryEntry("claim", "claim:second", "Second valid revision entry.")]
    });
    expect(recorded.revision).toBe(2);
    const recalled = await readSessionMemory({ repoRoot: repo, sessionId: "sid-invalid-revision", freshness });
    expect(recalled.revision).toBe(2);
    expect(recalled.memory.entries.map((entry) => entry.summary)).toEqual(
      expect.arrayContaining(["First valid revision entry.", "Second valid revision entry."])
    );
    expect(recorded.warnings).toContain("session memory store invalid: schema is invalid");
  });

  it("rejects store and event entries owned by a different logical session", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-entry-affinity-"));
    const freshness = freshnessFixture("snap-entry-affinity");
    const paths = sessionPaths(repo, "sid-entry-affinity");

    await recordSessionMemory({
      repoRoot: repo,
      sessionId: "sid-entry-affinity",
      freshness,
      entries: [memoryEntry("decision", "decision:owner", "Exact session owner entry.")]
    });
    const validStore = JSON.parse(await readFile(paths.memory, "utf8")) as SessionMemoryStore;
    const foreignStore = structuredClone(validStore);
    foreignStore.entries[0].sessionId = "sid-foreign";
    await writeFile(paths.memory, `${JSON.stringify(foreignStore, null, 2)}\n`, "utf8");

    const recoveredFromEvents = await readSessionMemory({
      repoRoot: repo,
      sessionId: "sid-entry-affinity",
      freshness
    });
    expect(recoveredFromEvents.memory.decisions[0]?.summary).toBe("Exact session owner entry.");
    expect(recoveredFromEvents.warnings).toContain("session memory store invalid: schema is invalid");

    await writeFile(paths.memory, `${JSON.stringify(validStore, null, 2)}\n`, "utf8");
    const [event] = (await readFile(paths.events, "utf8"))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as SessionMemoryEvent);
    event.entries[0].sessionId = "sid-foreign";
    await writeFile(paths.events, `${JSON.stringify(event)}\n`, "utf8");

    const recoveredFromStore = await readSessionMemory({
      repoRoot: repo,
      sessionId: "sid-entry-affinity",
      freshness
    });
    expect(recoveredFromStore.memory.decisions[0]?.summary).toBe("Exact session owner entry.");
    expect(recoveredFromStore.memory.entries.every((entry) => entry.sessionId === "sid-entry-affinity")).toBe(true);
    expect(recoveredFromStore.warnings).toContain("ignored invalid session memory event");
  });

  it("publishes the pointer before an implicit first event can become durable", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-implicit-pointer-"));
    const freshness = freshnessFixture("snap-implicit-pointer");
    const cacheDir = sessionMemoryCacheDir(repo);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path.join(cacheDir, "sessions"), "blocks session directory creation", "utf8");

    await expect(
      recordSessionMemory({
        repoRoot: repo,
        freshness,
        entries: [memoryEntry("decision", "decision:implicit", "Implicit session decision.")]
      })
    ).rejects.toThrow();

    const pointer = JSON.parse(await readFile(path.join(cacheDir, "latest.json"), "utf8")) as {
      sessionId: string;
      path: string;
    };
    expect(pointer.sessionId).toMatch(/^session-\d{14}-[a-f0-9]{8}$/u);
    expect(pointer.path).toBe(`sessions/${pointer.sessionId}/memory.json`);
  });
});

function sessionPaths(repoRoot: string, sessionId: string): { memory: string; events: string } {
  const directory = path.join(sessionMemoryCacheDir(repoRoot), "sessions", sessionId);
  return {
    memory: path.join(directory, "memory.json"),
    events: path.join(directory, "events.ndjson")
  };
}

async function readEvents(eventsPath: string): Promise<[SessionMemoryEvent, SessionMemoryEvent]> {
  const events = (await readFile(eventsPath, "utf8"))
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line) as SessionMemoryEvent);
  expect(events).toHaveLength(2);
  return [events[0], events[1]];
}

function memoryEntry(
  kind: "claim" | "decision" | "open_question",
  key: string,
  summary: string
): {
  kind: "claim" | "decision" | "open_question";
  key: string;
  summary: string;
  provenance: "agent-asserted";
  confidence: "heuristic";
  evidenceTier: "heuristic";
} {
  return {
    kind,
    key,
    summary,
    provenance: "agent-asserted",
    confidence: "heuristic",
    evidenceTier: "heuristic"
  };
}
