// Server-sent events plumbing for the side chat stream.
// ---- stream plumbing

export function sseHead(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-vercel-ai-ui-message-stream": "v1",
    "x-accel-buffering": "no"
  });
}

export function writeChunk(res, chunk) {
  if (!res.writableEnded) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

export function endStream(res) {
  if (!res.writableEnded) res.end("data: [DONE]\n\n");
}
