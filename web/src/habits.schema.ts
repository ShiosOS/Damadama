import { z } from "zod";

export const habitSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  good: z.string(),
  better: z.string(),
  best: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  schedule: z.object({
    weekdays: z.array(z.number().int().min(1).max(7)).nonempty(),
    repeatEveryWeeks: z.number().int().positive(),
    timeZone: z.string(),
    creationDate: z.iso.date(),
    firstWeekMonday: z.iso.date(),
  }),
});
export type Habit = z.infer<typeof habitSchema>;
export type NewHabit = Pick<Habit, "name" | "good" | "better" | "best"> &
  Pick<Habit["schedule"], "weekdays" | "repeatEveryWeeks" | "timeZone">;

export const weekdays = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 7, label: "Sunday" },
];
