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
const conflictSchema = problemSchema.extend({
  status: z.literal(409),
  current: entrySchema,
});
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function parse<T>(data: unknown, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success)
    throw new ApiError("The service returned an unexpected response.", 502);
  return parsed.data;
}

function refuse(data: unknown, status: number): never {
  const problem = problemSchema.safeParse(data);
  const message = problem.success
    ? Object.values(problem.data.errors ?? {})
        .flat()
        .join(" ") ||
      problem.data.detail ||
      problem.data.title
    : "The request could not be completed.";
  throw new ApiError(message, status);
}

export function habitsApi(getToken: () => Promise<string | null>): HabitsApi {
  async function send(
    path: string,
    options: RequestInit = {},
  ): Promise<{ response: Response; data: unknown }> {
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
    return { response, data };
  }
  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    status = 200,
    options: RequestInit = {},
  ): Promise<T> {
    const { response, data } = await send(path, options);
    if (!response.ok) refuse(data, response.status);
    if (
      response.status !== status ||
      response.headers.get("content-type")?.split(";")[0] !== "application/json"
    )
      throw new ApiError("The service returned an unexpected response.", 502);
    return parse(data, schema);
  }
  return {
    entries: (date) =>
      request(
        `/api/entries?date=${encodeURIComponent(date)}`,
        z.array(entrySchema),
      ),
    async saveEntry(habitId, date, input): Promise<Entry> {
      const path = `/api/habits/${habitId}/entries/${encodeURIComponent(date)}`;
      const { response, data } = await send(path, {
        method: "PUT",
        body: JSON.stringify(input),
      });
      const mediaType = response.headers.get("content-type")?.split(";")[0];
      let saved: Entry;
      if (response.status === 409 && mediaType === "application/problem+json") {
        saved = parse(data, conflictSchema).current;
      } else {
        if (!response.ok) refuse(data, response.status);
        if (
          (response.status !== 200 && response.status !== 201) ||
          mediaType !== "application/json" ||
          (response.status === 201 && response.headers.get("location") !== path)
        )
          throw new ApiError(
            "The service returned an unexpected response.",
            502,
          );
        saved = parse(data, entrySchema);
      }
      if (saved.habitId !== habitId || saved.calendarDate !== date)
        throw new ApiError("The service returned an unexpected response.", 502);
      return saved;
    },
    list: () => request("/api/habits", z.array(habitSchema)),
    scheduled: (date) =>
      request(
        `/api/habits?scheduledOn=${encodeURIComponent(date)}`,
        z.array(habitSchema),
      ),
    create: (input) =>
      request("/api/habits", habitSchema, 201, {
        method: "POST",
        body: JSON.stringify(input),
      }),
  };
}
