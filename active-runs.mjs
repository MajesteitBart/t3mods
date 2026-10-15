// Prints how many T3 runs are in progress. restart-and-apply.ps1 waits for 0.
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

const db = new DatabaseSync(path.join(os.homedir(), ".t3", "userdata", "statev2.sqlite"), { readOnly: true });
const { n } = db
  .prepare("SELECT count(*) AS n FROM orchestration_v2_projection_runs WHERE status IN ('preparing', 'queued', 'starting', 'running')")
  .get();
console.log(n);
