/* A misbehaving PDF reading process, for the isolation tests: hangs, crashes or answers nonsense. */
const mode = process.argv[2];
process.on("message", () => {
  if (mode === "hang") setInterval(() => {}, 1_000);
  if (mode === "busy") for (;;);
  if (mode === "crash") process.exit(3);
  if (mode === "garbage") process.send?.({ status: "text", text: 42 });
  if (mode === "memory") {
    const hoard: number[][] = [];
    for (;;) hoard.push(new Array(1_000_000).fill(1));
  }
});
