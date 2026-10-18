import { z } from "zod";
import { entrySchema, type Entry, type EntryEdit } from "./entries.schema";
import { habitSchema, type Habit, type NewHabit } from "./habits.schema";
export {
  habitSchema,
  weekdays,
  type Habit,
  type NewHabit,
} from "./habits.schema";

const siren = "application/vnd.siren+json";
const problemSchema = z.object({
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  errors: z.record(z.string(), z.array(z.string())).optional(),
  current: z.unknown().optional(),
});
const linkSchema = z.object({ rel: z.array(z.string()), href: z.string() });
const actionSchema = z.object({
  name: z.string(),
  method: z.enum(["GET", "POST", "PUT"]),
  href: z.string(),
  type: z.string(),
  fields: z.array(z.object({ name: z.string(), type: z.literal("text") })),
});
const resourceSchema = z.object({
  class: z.array(z.string()),
  properties: z.unknown(),
  links: z.array(linkSchema),
  actions: z.array(actionSchema),
  entities: z.array(z.unknown()),
});
type Resource = z.infer<typeof resourceSchema>;
type Action = z.infer<typeof actionSchema>;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export type EntryWriteContext = { deviceToday: string; timeZone: string };
export type EntrySaveOutcome =
  { kind: "saved"; entry: Entry } | { kind: "superseded"; entry: Entry };
export interface EntryEditor {
  save(edit: EntryEdit, context: EntryWriteContext): Promise<EntrySaveOutcome>;
}
export type ScheduledHabit = Habit & { editor: EntryEditor };
export type RecordedEntry = Entry & { editor: EntryEditor };
export interface HabitsApi {
  list(): Promise<Habit[]>;
  create(input: NewHabit): Promise<Habit>;
  scheduled(date: string): Promise<ScheduledHabit[]>;
  entries(date: string): Promise<RecordedEntry[]>;
}
export interface ApplicationBootstrap {
  clerkPublishableKey: string | null;
  forAccount(
    accountId: string,
    getToken: () => Promise<string | null>,
    currentAccount: () => string | null,
  ): HabitsApi;
}

function protocolError(): ApiError {
  return new ApiError("The service returned an unexpected response.", 502);
}
function target(href: string): URL {
  let url: URL;
  try {
    url = new URL(href, window.location.origin);
  } catch {
    throw protocolError();
  }
  if (
    url.origin !== window.location.origin ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw protocolError();
  return url;
}
function resource(data: unknown, kind: string): Resource {
  const parsed = resourceSchema.safeParse(data);
  if (!parsed.success || !parsed.data.class.includes(kind))
    throw protocolError();
  link(parsed.data, "self");
  link(parsed.data, "profile");
  return parsed.data;
}
function link(entity: Resource, relation: string): URL {
  const found = entity.links.filter((item) => item.rel.includes(relation));
  if (found.length !== 1 || !found[0]) throw protocolError();
  return target(found[0].href);
}
function action(
  entity: Resource,
  name: string,
  method: Action["method"],
  fields: string[],
): Action {
  const found = entity.actions.filter((item) => item.name === name);
  const result = found[0];
  if (
    found.length !== 1 ||
    !result ||
    result.method !== method ||
    result.type !==
      (method === "GET"
        ? "application/x-www-form-urlencoded"
        : "application/json") ||
    result.fields.length !== fields.length ||
    fields.some(
      (field) =>
        result.fields.filter((item) => item.name === field).length !== 1,
    )
  )
    throw protocolError();
  target(result.href);
  return result;
}
function properties<T>(entity: Resource, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(entity.properties);
  if (!parsed.success) throw protocolError();
  return parsed.data;
}
async function readJson(response: Response): Promise<unknown> {
  try {
    const data: unknown = await response.json();
    return data;
  } catch {
    throw new ApiError(
      "The service returned an unreadable response.",
      response.ok ? 502 : response.status,
    );
  }
}
function hasMedia(response: Response, expected: string): boolean {
  return (
    response.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase() === expected
  );
}
async function readResponse(
  response: Response,
  statuses: number[],
): Promise<unknown> {
  if (!response.ok) {
    if (!hasMedia(response, "application/problem+json"))
      throw new ApiError(
        "The request could not be completed.",
        response.status,
      );
    const parsed = problemSchema.safeParse(await readJson(response));
    if (!parsed.success || parsed.data.status !== response.status)
      throw new ApiError(
        "The service returned an unreadable error.",
        response.status,
      );
    const problem = parsed.data;
    throw new ApiError(
      Object.values(problem.errors ?? {})
        .flat()
        .join(" ") ||
        problem.detail ||
        problem.title,
      response.status,
    );
  }
  if (!statuses.includes(response.status) || !hasMedia(response, siren))
    throw protocolError();
  if (response.status === 201) {
    const location = response.headers.get("location");
    if (!location) throw protocolError();
    target(location);
  }
  return readJson(response);
}

// The browser fixture passes the unmodified envelope fetched from the real host.
export function readApplication(data: unknown): ApplicationBootstrap {
  const bootstrap = resource(data, "application");
  const config = properties(
    bootstrap,
    z.object({ clerkPublishableKey: z.string().nullable() }),
  );
  const habits = link(
    bootstrap,
    "https://github.com/ShiosOS/Damadama/rels/habits",
  );
  const create = action(bootstrap, "create-habit", "POST", [
    "name",
    "good",
    "better",
    "best",
    "weekdays",
    "repeatEveryWeeks",
    "timeZone",
  ]);
  const scheduled = action(bootstrap, "scheduled-habits", "GET", ["date"]);
  const entries = action(bootstrap, "entries-by-date", "GET", ["date"]);
  return {
    clerkPublishableKey: config.clerkPublishableKey,
    forAccount(accountId, getToken, currentAccount): HabitsApi {
      function assertAccount(): void {
        if (currentAccount() !== accountId)
          throw new ApiError("Sign in to continue.", 401);
      }
      async function request(
        url: URL,
        options: RequestInit = {},
      ): Promise<Response> {
        target(url.href);
        assertAccount();
        const token = await getToken();
        assertAccount();
        if (!token) throw new ApiError("Sign in to continue.", 401);
        const response = await fetch(url, {
          ...options,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: siren,
            ...(options.body ? { "Content-Type": "application/json" } : {}),
          },
        });
        assertAccount();
        return response;
      }
      async function submit(
        form: Action,
        values: Record<string, unknown>,
      ): Promise<Response> {
        const url = target(form.href);
        const fields = Object.fromEntries(
          form.fields.map((field) => [field.name, values[field.name]]),
        );
        if (form.method === "GET") {
          for (const [key, value] of Object.entries(fields)) {
            if (typeof value !== "string") throw protocolError();
            url.searchParams.set(key, value);
          }
          return request(url, { method: form.method });
        }
        return request(url, {
          method: form.method,
          body: JSON.stringify(fields),
        });
      }
      function editor(
        entity: Resource,
        habitId: string,
        date: string,
      ): EntryEditor {
        const replace = action(entity, "replace-entry", "PUT", [
          "result",
          "editedAt",
          "deviceToday",
          "timeZone",
        ]);
        return {
          async save(edit, context): Promise<EntrySaveOutcome> {
            const response = await submit(replace, { ...edit, ...context });
            let data: unknown;
            if (
              response.status === 409 &&
              hasMedia(response, "application/problem+json")
            ) {
              const parsed = problemSchema.safeParse(await readJson(response));
              if (!parsed.success || parsed.data.status !== 409)
                throw protocolError();
              data = parsed.data.current;
            } else data = await readResponse(response, [200, 201]);
            const winner = properties(resource(data, "entry"), entrySchema);
            if (winner.habitId !== habitId || winner.calendarDate !== date)
              throw protocolError();
            return {
              kind: response.status === 409 ? "superseded" : "saved",
              entry: winner,
            };
          },
        };
      }
      return {
        async list(): Promise<Habit[]> {
          const collection = resource(
            await readResponse(await request(habits), [200]),
            "habits",
          );
          return collection.entities.map((item) =>
            properties(resource(item, "habit"), habitSchema),
          );
        },
        async create(input): Promise<Habit> {
          return properties(
            resource(
              await readResponse(await submit(create, input), [201]),
              "habit",
            ),
            habitSchema,
          );
        },
        async scheduled(date): Promise<ScheduledHabit[]> {
          const collection = resource(
            await readResponse(await submit(scheduled, { date }), [200]),
            "scheduled-habits",
          );
          return collection.entities.map((item) => {
            const entity = resource(item, "habit");
            const habit = properties(entity, habitSchema);
            return { ...habit, editor: editor(entity, habit.id, date) };
          });
        },
        async entries(date): Promise<RecordedEntry[]> {
          const collection = resource(
            await readResponse(await submit(entries, { date }), [200]),
            "entries",
          );
          return collection.entities.map((item) => {
            const entity = resource(item, "entry");
            const entry = properties(entity, entrySchema);
            if (entry.calendarDate !== date) throw protocolError();
            return { ...entry, editor: editor(entity, entry.habitId, date) };
          });
        },
      };
    },
  };
}
export async function loadApplication(): Promise<ApplicationBootstrap> {
  const response = await fetch("/api/config", { headers: { Accept: siren } });
  return readApplication(await readResponse(response, [200]));
}
