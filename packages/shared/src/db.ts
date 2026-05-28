import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

const dbUrl = process.env.DB_URL;

if (!dbUrl) {
  throw new Error("DB_URL is not defined in environment variables");
}

const pool = new Pool({ connectionString: dbUrl });

function sql(
  strings: TemplateStringsArray | string,
  ...values: unknown[]
) {
  if (typeof strings === "string") {
    return pool.query(strings, values as any[]).then((r) => r.rows);
  }
  let text = "";
  (strings as TemplateStringsArray).forEach((str, i) => {
    text += str;
    if (i < values.length) text += `$${i + 1}`;
  });
  return pool.query(text, values as any[]).then((r) => r.rows);
}

sql.query = (text: string, params?: unknown[]) =>
  pool.query(text, params as any[]).then((r) => r.rows);

export { sql };
