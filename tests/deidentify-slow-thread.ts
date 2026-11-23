/* A stand-in worker that never answers: for the de-identification thread's timeout test. */
import { parentPort } from "node:worker_threads";

parentPort?.on("message", () => {
  // Never answers.
});
