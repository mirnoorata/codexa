export function validServerEvent(sequence = 1) {
  return {
    schemaVersion: 1,
    sequence,
    outcome: "ok",
    tool: "task_brief",
    profile: "core",
    requestedFormat: "auto",
    effectiveFormat: "concise",
    requestBytes: 20,
    textBytes: 40,
    structuredBytes: 60,
    totalBytes: 120,
    elapsedMs: 5,
    unchangedReceipt: false
  };
}

export function validServerCompletion(eventCount: number) {
  return {
    schemaVersion: 1,
    recordKind: "session-complete",
    sequence: eventCount + 1,
    eventCount
  };
}
