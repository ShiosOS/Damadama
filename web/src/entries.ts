import { z } from "zod";

export const entryResultSchema = z.enum([
  "Good",
  "Better",
  "Best",
  "Rest",
  "Clear",
]);

export const entrySchema = z.object({
  habitId: z.uuid(),
  habitName: z.string(),
  calendarDate: z.iso.date(),
  result: entryResultSchema,
  editedAt: z.iso.datetime({ offset: true }),
  good: z.string(),
  better: z.string(),
  best: z.string(),
});

export type Entry = z.infer<typeof entrySchema>;
export type EntryEdit = Pick<Entry, "result" | "editedAt">;
