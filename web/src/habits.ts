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

export function habitsApi(getToken: () => Promise<string | null>) {
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
    list: () => request("/api/habits", z.array(habitSchema)),
    create: (input: NewHabit) =>
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
