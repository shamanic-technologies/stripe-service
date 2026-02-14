import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("Drizzle migrations", () => {
  const drizzleDir = path.resolve(__dirname, "../../drizzle");
  const metaDir = path.join(drizzleDir, "meta");

  it("drizzle/ directory exists", () => {
    expect(fs.existsSync(drizzleDir)).toBe(true);
  });

  it("meta/_journal.json exists", () => {
    expect(fs.existsSync(path.join(metaDir, "_journal.json"))).toBe(true);
  });

  it("_journal.json has at least one migration entry", () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(metaDir, "_journal.json"), "utf-8")
    );
    expect(journal.entries.length).toBeGreaterThan(0);
  });

  it("each journal entry has a corresponding SQL file", () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(metaDir, "_journal.json"), "utf-8")
    );
    for (const entry of journal.entries) {
      const sqlFile = path.join(drizzleDir, `${entry.tag}.sql`);
      expect(fs.existsSync(sqlFile), `Missing SQL file: ${entry.tag}.sql`).toBe(
        true
      );
    }
  });
});
