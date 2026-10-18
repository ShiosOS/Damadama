import { z } from "zod";
import { entrySchema, type Entry, type EntryEdit } from "./entries.schema";
import { habitSchema, type Habit, type NewHabit } from "./habits.schema";

export type WriteEntryInput = EntryEdit & {
  deviceToday: string;
  timeZone: string;
};

export interface HabitsApi {
  entries(date: string): Promise<Entry[]>;
  saveEntry(
    habitId: string,
    date: string,
    input: WriteEntryInput,
  ): Promise<Entry>;
  list(): Promise<Habit[]>;
  scheduled(date: string): Promise<Habit[]>;
  create(input: NewHabit): Promise<Habit>;
}
const problemSchema = z.object({
  title: z.string(),
  detail: z.string().optional(),
  traceId: z.string().optional(),
  errors: z.record(z.string(), z.array(z.string())).optional(),
});
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function habitsApi(getToken: () => Promise<string | null>): HabitsApi {
  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: RequestInit = {},
  ): Promise<T> {
    const token = await getToken();
    if (!token) throw new ApiError("Sign in to continue.", 401);
    const response = await fetch(path, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    const data: unknown = await response.json();
    if (!response.ok) {
      const problem = problemSchema.safeParse(data);
      const message = problem.success
        ? Object.values(problem.data.errors ?? {})
            .flat()
            .join(" ") ||
          problem.data.detail ||
          problem.data.title
        : "The request could not be completed.";
      throw new ApiError(message, response.status);
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success)
      throw new ApiError("The service returned an unexpected response.", 502);
    return parsed.data;
  }
  return {
    entries: (date: string): Promise<Entry[]> =>
      request(
        `/api/entries?date=${encodeURIComponent(date)}`,
        z.array(entrySchema),
      ),
    saveEntry: (
      habitId: string,
      date: string,
      input: WriteEntryInput,
    ): Promise<Entry> =>
      request(
        `/api/habits/${habitId}/entries/${encodeURIComponent(date)}`,
        entrySchema,
        {
          method: "PUT",
          body: JSON.stringify(input),
        },
      ),
    list: (): Promise<Habit[]> => request("/api/habits", z.array(habitSchema)),
    scheduled: (date: string): Promise<Habit[]> =>
      request(
        `/api/habits/scheduled?date=${encodeURIComponent(date)}`,
        z.array(habitSchema),
      ),
    create: (input: NewHabit): Promise<Habit> =>
      request("/api/habits", habitSchema, {
        method: "POST",
        body: JSON.stringify(input),
      }),
  };
}

export const weekdays = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 7, label: "Sunday" },
];
