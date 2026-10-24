/// <reference types="node" />
import { readSync } from "node:fs";
import { healthScope, recordKey } from "../src/health/scope.js";
import { HealthStore, HealthStoreError } from "../src/health/store.js";

const [mode, path, identity] = process.argv.slice(2);
const store = new HealthStore(path, { now: () => 1_790_000_000_000 });
try {
  store.update((state) => {
    const scope = healthScope(identity, "project-test", "opus");
    state.records[recordKey(scope)] = {
      ...scope,
      status: "unknown",
      reason: "unknown",
      observedAt: 1_790_000_000_000,
      cooldownUntil: 0,
    };
    if (mode === "hold") {
      process.stdout.write("LOCKED\n");
      const command = Buffer.alloc(1);
      if (readSync(0, command, 0, 1, null) !== 1) throw new Error("Missing release signal.");
      if (command[0] === 88) process.exit(17);
    }
  });
  process.stdout.write("COMMITTED\n");
} catch (error) {
  if (!(error instanceof HealthStoreError)) throw error;
  process.stdout.write(`ERROR:${error.code}\n`);
}
