import { PrismaClient } from "@prisma/client";
import { loadEnv } from "./env";

loadEnv();

if (!process.env.DB_URL) {
  throw new Error("DB_URL is not defined in environment variables");
}

const prisma = new PrismaClient();

export { prisma };
