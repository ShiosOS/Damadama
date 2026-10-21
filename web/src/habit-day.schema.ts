import { z } from "zod";
import { habitSchema } from "./habits.schema";
import { entrySchema } from "./entries.schema";

export const habitDaySchema = z
  .object({
    date: z.iso.date(),
    habits: z.array(habitSchema),
    entries: z.array(entrySchema),
  })
  .refine(
    (day) =>
      day.entries.every((entry) => entry.calendarDate === day.date) &&
      new Set(day.habits.map((habit) => habit.id)).size === day.habits.length &&
      new Set(day.entries.map((entry) => entry.habitId)).size ===
        day.entries.length,
  );

export type HabitDay = z.infer<typeof habitDaySchema>;
