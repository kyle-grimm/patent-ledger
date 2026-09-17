#!/usr/bin/env node
// Print a PATENT_LEDGER_USERS entry for a password: node scripts/hash-password.mjs '<password>'
import { randomBytes, scryptSync } from "node:crypto";

const password = process.argv[2];
if (!password) {
  console.error("usage: node scripts/hash-password.mjs '<password>'");
  process.exit(1);
}
const salt = randomBytes(16);
const hash = scryptSync(password, salt, 32);
console.log(`scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`);
