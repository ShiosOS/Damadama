import type { EntryEdit } from "./entries.schema";

export type EntryActivity =
  | { kind: "idle" }
  | { kind: "saving"; edit: EntryEdit }
  | { kind: "error"; message: string; edit: EntryEdit };
