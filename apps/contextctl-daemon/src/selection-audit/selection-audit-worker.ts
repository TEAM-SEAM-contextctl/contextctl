import { parentPort, workerData } from "node:worker_threads";

import type { SelectionAuditRecord } from "@contextctl/selection-delivery";

import type { DaemonStateIdentity } from "../runtime/state-identity.js";
import {
  openSelectionAuditDatabase,
  SqliteSelectionAuditStore,
} from "./sqlite-selection-audit-store.js";

interface WorkerInput {
  readonly location: string;
  readonly stateIdentity: DaemonStateIdentity;
}

interface WorkerRequest {
  readonly requestId: number;
  readonly operation: "append" | "list" | "find" | "close";
  readonly value: unknown;
}

const port = parentPort;
if (port === null) {
  throw new Error("selection audit worker requires a parent port");
}
const input = workerData as WorkerInput;
const database = openSelectionAuditDatabase(input);
const store = new SqliteSelectionAuditStore(database, Date.now, input.location);
let queue = Promise.resolve();

port.postMessage({ status: "ready" });
port.on("message", (request: WorkerRequest) => {
  queue = queue.then(async () => {
    try {
      let value: unknown;
      if (request.operation === "append") {
        await store.append(request.value as SelectionAuditRecord);
      } else if (request.operation === "list") {
        value = await store.list(request.value as number);
      } else if (request.operation === "find") {
        value = await store.find(request.value as string);
      } else {
        database.close();
      }
      port.postMessage({
        requestId: request.requestId,
        status: "fulfilled",
        value,
      });
      if (request.operation === "close") port.close();
    } catch (error) {
      port.postMessage({
        requestId: request.requestId,
        status: "rejected",
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });
});
