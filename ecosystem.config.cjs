// Paths are resolved relative to this file, so the deployment location is not
// recorded in the repository. Override the Bun binary with BUN_BIN if it is
// installed somewhere other than /usr/local/bin.
const { join } = require("node:path");

module.exports = {
  apps: [
    {
      name: "nobeds-telegram",
      cwd: __dirname,
      script: "src/index.ts",
      interpreter: process.env.BUN_BIN || "/usr/local/bin/bun",
      env: { NODE_ENV: "production" },

      // Single instance, fork mode, always. Two processes would long-poll the
      // same bot token (Telegram answers the second one with 409 Conflict) and
      // write the same SQLite file, which is how you get duplicate booking
      // notifications. pm2's cluster mode would also force Node over Bun.
      instances: 1,
      exec_mode: "fork",

      autorestart: true,
      restart_delay: 5000,
      exp_backoff_restart_delay: 5000,
      max_restarts: 50,
      min_uptime: "30s",
      max_memory_restart: "400M",

      // Daily restart (03:30 UTC, 06:30 Vilnius): CPU and heap creep up over weeks
      // of uptime, and a fresh process resets them. Polls resume immediately.
      cron_restart: "30 3 * * *",

      // The poll loop persists its snapshot only after every notification is
      // sent, so give SIGINT time to finish an in-flight send rather than
      // killing it mid-notification.
      kill_timeout: 10000,

      out_file: join(__dirname, "logs/out.log"),
      error_file: join(__dirname, "logs/err.log"),
      merge_logs: true,
      time: true,
    },
  ],
};
