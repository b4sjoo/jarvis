#!/usr/bin/env node

import {
  loadDeletionLedger,
  validateDeletionLedger,
} from "./lib/maintainability-deletion-ledger.mjs";

const validation = validateDeletionLedger(loadDeletionLedger());
if (!validation.ok) {
  console.error("Maintainability deletion ledger is invalid:");
  for (const error of validation.errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Deletion ledger: ${validation.entryCount} entries ` +
    `(${Object.entries(validation.statusCounts)
      .map(([status, count]) => `${status}=${count}`)
      .join(", ")})`
);
