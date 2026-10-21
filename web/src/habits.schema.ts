import { z } from "zod";

export const habitSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  good: z.string(),
  better: z.string(),
  best: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  archived: z.boolean().default(false),
  revision: z.number().int().nonnegative().default(0),
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

const mutationSchema = z.object({
  mutationId: z.uuid(),
  deviceToday: z.iso.date(),
  timeZone: z.string().min(1),
  todayChoice: z.enum(["Keep", "Remove"]).optional(),
});
export const editHabitSchema = mutationSchema.extend({
  name: z.string(),
  good: z.string(),
  better: z.string(),
  best: z.string(),
  schedule: habitSchema.shape.schedule
    .pick({ weekdays: true, repeatEveryWeeks: true })
    .optional(),
});
export type HabitEdit = z.infer<typeof editHabitSchema>;
export type HabitArchive = z.infer<typeof mutationSchema>;

export const weekdays = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 7, label: "Sunday" },
];
