import { Hono } from "hono";
import { cors } from "hono/cors";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { gatewayRoutes } from "./routes/gateway.js";
import { contentRoutes } from "./routes/content.js";
import { accessRoutes } from "./routes/access.js";
import { x402Routes } from "./routes/x402.js";
import { receiptsRoutes } from "./routes/receipts.js";
import { settlementRoutes } from "./routes/settlement.js";
import { sitesRoutes } from "./routes/sites.js";
import { aiRoutes } from "./routes/ai.js";

const app = new Hono();

app.use("*", cors({
  origin: (origin) => {
    if (!origin) return null;
    if (origin.startsWith("chrome-extension://")) return origin;
    if (origin === "https://community.arc.io") return origin;
    if (origin === "https://community.arc.network") return origin;
    if (origin === "https://sepiasearch.org") return origin;
    if (origin === process.env.PAYLABS_PUBLIC_ORIGIN) return origin;
    return null;
  },
  allowHeaders: ["Content-Type", "Authorization", "X-Paylabs-Client"],
  allowMethods: ["GET", "POST", "OPTIONS"],
  credentials: false
}));

app.get("/", (c) => c.json({
  name: "Paylabs API",
  purpose: "Paid AI discovery + paid thread opening backend (x402 / Circle Gateway on Arc)",
  status: "ok"
}));

app.route("/health", healthRoutes);
app.route("/api/auth", authRoutes);
app.route("/api/gateway", gatewayRoutes);
app.route("/api/content", contentRoutes);
app.route("/api/access", accessRoutes);
app.route("/api/x402", x402Routes);
app.route("/api/receipts", receiptsRoutes);
app.route("/api/settlement", settlementRoutes);
app.route("/api/sites", sitesRoutes);
app.route("/api/ai", aiRoutes);

export default app;
