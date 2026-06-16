import postgres from "postgres";
import { config } from "../config.js";

const sql = postgres(config.databaseUrl, {
  max: 5,
  idle_timeout: 20,
  connect_timeout: 10,
});

export default sql;
