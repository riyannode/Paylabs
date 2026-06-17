import app from "../src/app.js";

// Vercel Node.js runtime handler — works with postgres driver
export const config = {
  runtime: "nodejs",
};

export default async function handler(req: Request) {
  return app.fetch(req);
}
