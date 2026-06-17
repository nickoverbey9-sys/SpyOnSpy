import { dashboardSnapshots } from "@shared/schema";
import type {
  DashboardSnapshot,
  InsertDashboardSnapshot,
} from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { desc } from "drizzle-orm";

const sqlite = new Database("data.db");
sqlite.pragma("journal_mode = WAL");
sqlite
  .prepare(
    `CREATE TABLE IF NOT EXISTS dashboard_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      payload TEXT NOT NULL
    )`,
  )
  .run();

export const db = drizzle(sqlite);

export interface IStorage {
  createDashboardSnapshot(
    snapshot: InsertDashboardSnapshot,
  ): Promise<DashboardSnapshot>;
  getLatestDashboardSnapshot(): Promise<DashboardSnapshot | undefined>;
}

export class DatabaseStorage implements IStorage {
  async createDashboardSnapshot(
    snapshot: InsertDashboardSnapshot,
  ): Promise<DashboardSnapshot> {
    return db.insert(dashboardSnapshots).values(snapshot).returning().get();
  }

  async getLatestDashboardSnapshot(): Promise<DashboardSnapshot | undefined> {
    return db
      .select()
      .from(dashboardSnapshots)
      .orderBy(desc(dashboardSnapshots.id))
      .limit(1)
      .get();
  }
}

export const storage = new DatabaseStorage();

