/**
 * PayLabs Discovery Worker — PM2 Ecosystem Config
 *
 * Resilience features:
 * - Sources .env.local before starting (solves pm2 restart --update-env bug)
 * - exp_backoff_restart_delay: backs off on repeated crashes
 * - max_memory_restart: restarts if memory leak detected
 * - kill_timeout: graceful shutdown for in-flight LLM calls
 * - watch: false (no auto-restart on file changes in production)
 * - max_restarts: unlimited (keep trying)
 * - min_uptime: consider crash if exits within 10s
 */

const { execSync } = require("child_process");
const { readFileSync, existsSync } = require("fs");
const { join } = require("path");

const WORKDIR = "/root/Paylabs";
const ENV_FILE = join(WORKDIR, ".env.local");

// Load .env.local into process.env for PM2
function loadEnv() {
  if (!existsSync(ENV_FILE)) {
    console.error("[ecosystem] ERROR: .env.local not found at", ENV_FILE);
    process.exit(1);
  }
  const lines = readFileSync(ENV_FILE, "utf-8").split("\n");
  const env = {};
  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 1) continue;
    const key = line.slice(0, idx);
    let val = line.slice(idx + 1);
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

const env = loadEnv();

module.exports = {
  apps: [
    {
      name: "paylabs-discovery-worker",
      cwd: WORKDIR,
      script: "pnpm",
      args: "worker:discovery",
      interpreter: "none",

      // Environment from .env.local
      env,

      // Resilience
      autorestart: true,               // auto-restart on crash
      max_restarts: 100,               // keep trying
      min_uptime: 10000,               // crash if exits within 10s
      exp_backoff_restart_delay: 5000, // 5s → 10s → 20s → 40s → ... (max 15min)
      max_memory_restart: "512M",      // restart if memory leak
      kill_timeout: 60000,             // 60s grace for in-flight LLM calls
      listen_timeout: 10000,           // startup timeout
      shutdown_with_message: false,

      // Logging
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "/root/.pm2/logs/paylabs-discovery-worker-error.log",
      out_file: "/root/.pm2/logs/paylabs-discovery-worker-out.log",
      merge_logs: true,

      // No file watching in production
      watch: false,
      ignore_watch: ["node_modules", ".git", ".env.local"],

      // Health
      health_check: false,
    },
  ],
};
