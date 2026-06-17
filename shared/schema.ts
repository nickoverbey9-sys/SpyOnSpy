import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const dashboardSnapshots = sqliteTable("dashboard_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  createdAt: text("created_at").notNull(),
  payload: text("payload").notNull(),
});

export const insertDashboardSnapshotSchema = createInsertSchema(
  dashboardSnapshots,
).omit({
  id: true,
});

export type InsertDashboardSnapshot = z.infer<
  typeof insertDashboardSnapshotSchema
>;
export type DashboardSnapshot = typeof dashboardSnapshots.$inferSelect;

