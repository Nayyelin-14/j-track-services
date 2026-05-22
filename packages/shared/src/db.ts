import { neon } from "@neondatabase/serverless";
import dotenv from "dotenv";

dotenv.config();

const dbUrl = process.env.DB_URL;

if (!dbUrl) {
  throw new Error("DB_URL is not defined in environment variables");
}

export const sql = neon(dbUrl);
