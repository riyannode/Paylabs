import { handle } from "@hono/node-server/vercel";
import app from "../src/app.js";

export const config = {
  runtime: "nodejs",
};

// Wrap handle to ensure POST body is consumed before Hono reads it
const handler = handle(app);

export default async function vercelHandler(req: any, res: any) {
  // Ensure request body is fully buffered for non-GET/HEAD requests
  if (req.method && req.method !== "GET" && req.method !== "HEAD" && !req.rawBody) {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        req.rawBody = Buffer.concat(chunks);
        resolve();
      });
      req.on("error", reject);
    });
  }
  return handler(req, res);
}
