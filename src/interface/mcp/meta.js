import { readFileSync } from "node:fs";

// Report the real package version. This string had drifted to 0.4.0 while the
// package shipped 0.5.x, so the handshake named a version nobody was running.
export const packageVersion = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8")
).version;
