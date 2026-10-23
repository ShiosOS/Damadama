import { z } from "zod";
import { entrySchema, type Entry, type EntryEdit } from "./entries.schema";
import { habitDaySchema, type HabitDay } from "./habit-day.schema";
import {
  heatmapSchema,
  type Heatmap,
  type HeatmapAnchor,
} from "./heatmap.schema";
import {
  habitSchema,
  type Habit,
  type NewHabit,
  type HabitEdit,
  type HabitArchive,
} from "./habits.schema";

export type WriteEntryInput = EntryEdit & {
  deviceToday: string;
  timeZone: string;
};
export interface HabitsApi {
  heatmap(anchor: HeatmapAnchor): Promise<Heatmap>;
  day(date: string): Promise<HabitDay>;
  entries(date: string): Promise<Entry[]>;
  saveEntry(
    habitId: string,
    date: string,
    input: WriteEntryInput,
  ): Promise<Entry>;
  list(): Promise<Habit[]>;
  scheduled(date: string): Promise<Habit[]>;
  create(input: NewHabit): Promise<Habit>;
  edit(habitId: string, input: HabitEdit): Promise<Habit>;
  archive(habitId: string, input: HabitArchive): Promise<Habit>;
}
const problemSchema = z.object({
  title: z.string(),
  detail: z.string().optional(),
  errors: z.record(z.string(), z.array(z.string())).optional(),
  code: z.string().optional(),
});
const conflictSchema = problemSchema.extend({
  status: z.literal(409),
  current: entrySchema,
});
const traceIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9:_-]+$/);
const referenceSchema = z.object({ traceId: traceIdSchema });
const mutationCodeSchema = z.enum([
  "today_choice_required",
  "mutation_mismatch",
]);

export class ApiError extends Error {
  readonly traceId: string | undefined;
  declare readonly code?: z.infer<typeof mutationCodeSchema>;

  constructor(
    message: string,
    readonly status: number,
    traceId?: string,
    code?: string,
  ) {
    const reference = traceIdSchema.safeParse(traceId);
    const validated = reference.success ? reference.data : undefined;
    super(validated ? `${message} Support reference: ${validated}.` : message);
    this.traceId = validated;
    const mutation = mutationCodeSchema.safeParse(code);
    if (mutation.success) this.code = mutation.data;
  }
}

function reference(data: unknown): string | undefined {
  const parsed = referenceSchema.safeParse(data);
  return parsed.success ? parsed.data.traceId : undefined;
}

function parse<T>(data: unknown, schema: z.ZodType<T>, traceId?: string): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success)
    throw new ApiError(
      "The service returned an unexpected response.",
      502,
      traceId,
    );
  return parsed.data;
}

function refuse(data: unknown, status: number): never {
  const problem = problemSchema.safeParse(data);
  let message = "The request could not be completed.";
  if (status === 401) message = "Sign in to continue.";
  else if (problem.success)
    message =
      Object.values(problem.data.errors ?? {})
        .flat()
        .join(" ") ||
      problem.data.detail ||
      problem.data.title;
  throw new ApiError(
    message,
    status,
    reference(data),
    problem.success ? problem.data.code : undefined,
  );
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
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new ApiError("The service returned an unexpected response.", 502);
    }
    return { response, data };
  }
  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    status = 200,
    options: RequestInit = {},
  ): Promise<T> {
    const { response, data } = await send(path, options);
    const traceId = reference(data);
    if (!response.ok) refuse(data, response.status);
    if (
      response.status !== status ||
      response.headers.get("content-type")?.split(";")[0] !== "application/json"
    )
      throw new ApiError(
        "The service returned an unexpected response.",
        502,
        traceId,
      );
    return parse(data, schema, traceId);
  }
  return {
    async heatmap(anchor): Promise<Heatmap> {
      const query = new URLSearchParams(anchor);
      const heatmap = await request(
        `/api/heatmaps?${query.toString()}`,
        heatmapSchema,
      );
      if (heatmap.end !== anchor.deviceToday)
        throw new ApiError("The service returned an unexpected response.", 502);
      return heatmap;
    },
    async day(date): Promise<HabitDay> {
      const day = await request(
        `/api/habit-days/${encodeURIComponent(date)}`,
        habitDaySchema,
      );
      if (day.date !== date)
        throw new ApiError("The service returned an unexpected response.", 502);
      return day;
    },
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
      const traceId = reference(data);
      let saved: Entry;
      if (response.status === 409 && mediaType === "application/problem+json") {
        saved = parse(data, conflictSchema, traceId).current;
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
            traceId,
          );
        saved = parse(data, entrySchema, traceId);
      }
      if (saved.habitId !== habitId || saved.calendarDate !== date)
        throw new ApiError(
          "The service returned an unexpected response.",
          502,
          traceId,
        );
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
    async edit(habitId, input): Promise<Habit> {
      const saved = await request(`/api/habits/${habitId}`, habitSchema, 200, {
        method: "PATCH",
        body: JSON.stringify(input),
      });
      if (saved.id !== habitId)
        throw new ApiError("The service returned an unexpected response.", 502);
      return saved;
    },
    async archive(habitId, input): Promise<Habit> {
      const saved = await request(
        `/api/habits/${habitId}/archives`,
        habitSchema,
        200,
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      );
      if (saved.id !== habitId)
        throw new ApiError("The service returned an unexpected response.", 502);
      return saved;
    },
  };
}
