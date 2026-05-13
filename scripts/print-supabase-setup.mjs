#!/usr/bin/env node
/**
 * Prints supabase/SETUP_DATABASE.sql for pasting into Supabase Dashboard → SQL Editor.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.join(__dirname, "..", "supabase", "SETUP_DATABASE.sql");
const sql = fs.readFileSync(sqlPath, "utf8");

console.log(`
Paste the SQL below into: Supabase Dashboard → SQL Editor → New query → Run

--- START -------------------------------------------------------------------

${sql.trim()}

--- END ---------------------------------------------------------------------
`);
