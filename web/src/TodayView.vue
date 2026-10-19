<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  shallowRef,
  watch,
} from "vue";
import { z } from "zod";
import { ApiError, habitsApi } from "./habits";
import type { Habit } from "./habits.schema";
import HabitDetails from "./HabitDetails.vue";
import HabitLevels from "./HabitLevels.vue";
import EntryControls from "./EntryControls.vue";
import type { Entry, EntryEdit } from "./entries.schema";
import type { TodayHandle } from "./TodayView.types";

type Props = {
  accountId: string | null;
  getToken: () => Promise<string | null>;
};
const props = defineProps<Props>();
type TodayState =
  | { kind: "loading"; date: string }
  | { kind: "ready"; date: string; habits: Habit[]; entries: Entry[] }
  | { kind: "error"; date: string; message: string };
type TodayRow =
  | {
      kind: "scheduled";
      key: string;
      habitId: string;
      name: string;
      entry: Entry | undefined;
      habit: Habit;
    }
  | {
      kind: "retained";
      key: string;
      habitId: string;
      name: string;
      entry: Entry;
    };
type Load = { generation: number; date: string; accountId: string | null };

function localCalendarDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const api = habitsApi(() => props.getToken());
const selectedDate = ref<string | null>(null);
const deviceToday = ref(localCalendarDate());
const requestedDate = (): string => selectedDate.value ?? localCalendarDate();
const state = shallowRef<TodayState>({
  kind: "loading",
  date: localCalendarDate(),
});
const dateLabel = computed(() =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(
    new Date(`${state.value.date}T12:00:00`),
  ),
);
let generation = 0;
let disposed = false;
let midnightTimer: ReturnType<typeof setTimeout> | undefined;
const rows = computed<TodayRow[]>(() => {
  const current = state.value;
  if (current.kind !== "ready") return [];
  const entries = new Map(
    current.entries.map((entry) => [entry.habitId, entry]),
  );
  const scheduledIds = new Set(current.habits.map((habit) => habit.id));
  const scheduled: TodayRow[] = current.habits.map((habit) => {
    const entry = entries.get(habit.id);
    const displayedHabit = entry
      ? { ...habit, good: entry.good, better: entry.better, best: entry.best }
      : habit;
    return {
      kind: "scheduled",
      key: habit.id,
      habitId: habit.id,
      name: habit.name,
      entry,
      habit: displayedHabit,
    };
  });
  const retained: TodayRow[] = current.entries
    .filter((entry) => !scheduledIds.has(entry.habitId))
    .map((entry) => ({
      kind: "retained",
      key: `retained-${entry.habitId}`,
      habitId: entry.habitId,
      name: entry.habitName,
      entry,
    }));
  return [...scheduled, ...retained];
});

function selectDate(event: Event): void {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  const value = input.value;
  if (!z.iso.date().safeParse(value).success || value > localCalendarDate()) {
    input.value = state.value.date;
    return;
  }
  selectedDate.value = value === localCalendarDate() ? null : value;
}

function saveEntry(habitId: string, edit: EntryEdit): Promise<Entry> {
  return api.saveEntry(habitId, state.value.date, {
    ...edit,
    deviceToday: localCalendarDate(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
}

function acceptEntry(entry: Entry): void {
  const current = state.value;
  if (current.kind !== "ready" || current.date !== entry.calendarDate) return;
  state.value = {
    ...current,
    entries: [
      ...current.entries.filter((saved) => saved.habitId !== entry.habitId),
      entry,
    ],
  };
}

function signInRequired(): void {
  generation++;
  state.value = {
    kind: "error",
    date: state.value.date,
    message: "Sign in to continue.",
  };
}

function armMidnight(): void {
  clearTimeout(midnightTimer);
  const now = new Date();
  const midnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  );
  midnightTimer = setTimeout(checkDate, midnight.getTime() - now.getTime());
}

function checkDate(): void {
  deviceToday.value = localCalendarDate();
  if (requestedDate() !== state.value.date) void refresh();
  else armMidnight();
}

function onVisible(): void {
  if (document.visibilityState === "visible") checkDate();
}

function isCurrentLoad(load: Load): boolean {
  return (
    !disposed &&
    load.generation === generation &&
    load.accountId === props.accountId
  );
}

async function refresh(mode: "all" | "schedule" = "all"): Promise<Load | null> {
  const load: Load = {
    generation: ++generation,
    date: requestedDate(),
    accountId: props.accountId,
  };
  const keepEntries =
    mode === "schedule" &&
    state.value.kind === "ready" &&
    state.value.date === load.date;
  deviceToday.value = localCalendarDate();
  if (!keepEntries) state.value = { kind: "loading", date: load.date };
  armMidnight();
  if (!load.accountId) return null;
  try {
    const [habits, loadedEntries] = await Promise.all([
      api.scheduled(load.date),
      keepEntries ? Promise.resolve([]) : api.entries(load.date),
    ]);
    if (!isCurrentLoad(load)) return null;
    if (load.date !== requestedDate()) {
      void refresh();
      return null;
    }
    const entries =
      keepEntries && state.value.kind === "ready"
        ? state.value.entries
        : loadedEntries;
    state.value = { kind: "ready", date: load.date, habits, entries };
  } catch (error) {
    if (!isCurrentLoad(load)) return null;
    if (load.date !== requestedDate()) {
      void refresh();
      return null;
    }
    let message =
      "Could not reach the service. Check your connection and try again.";
    if (error instanceof ApiError && error.status === 401) {
      message = "Sign in to continue.";
    } else if (error instanceof ApiError) {
      message = error.message;
    }
    state.value = { kind: "error", date: load.date, message };
  }
  return load;
}

async function refreshAfterCreate(): ReturnType<
  TodayHandle["refreshAfterCreate"]
> {
  const load = await refresh("schedule");
  await nextTick();
  if (!load || !isCurrentLoad(load) || load.date !== requestedDate())
    return null;
  return () => isCurrentLoad(load) && load.date === requestedDate();
}

defineExpose({ refreshAfterCreate } satisfies TodayHandle);

watch(
  () => ({
    account: props.accountId,
    date: selectedDate.value,
  }),
  () => void refresh(),
  {
    immediate: true,
    flush: "sync",
  },
);
onMounted(() => {
  window.addEventListener("focus", checkDate);
  document.addEventListener("visibilitychange", onVisible);
});
onUnmounted(() => {
  disposed = true;
  generation++;
  clearTimeout(midnightTimer);
  window.removeEventListener("focus", checkDate);
  document.removeEventListener("visibilitychange", onVisible);
});
</script>

<template>
  <section aria-labelledby="today-heading" class="today-view">
    <h2 id="today-heading" class="page-title">
      {{ selectedDate ? "Entries" : "Today" }}
    </h2>
    <time :datetime="state.date" class="today-date">{{ dateLabel }}</time>
    <div class="mb-5 flex flex-wrap items-end gap-3">
      <UFormField label="Calendar date" name="calendar-date">
        <UInput
          type="date"
          aria-label="Calendar date"
          :model-value="state.date"
          :max="deviceToday"
          @change="selectDate"
        />
      </UFormField>
      <UButton
        v-if="selectedDate"
        color="neutral"
        variant="outline"
        class="rounded-full"
        @click="selectedDate = null"
        >Today</UButton
      >
    </div>
    <p v-if="state.kind === 'loading'" role="status" class="empty-habits">
      {{ selectedDate ? "Loading entries…" : "Loading today's habits…" }}
    </p>
    <div v-else-if="state.kind === 'error'" class="today-error">
      <UAlert
        role="alert"
        color="error"
        :title="
          selectedDate ? 'Could not load entries' : 'Could not load today'
        "
        :description="state.message"
      />
      <UButton variant="outline" class="rounded-full" @click="refresh()"
        >Retry</UButton
      >
    </div>
    <template v-else>
      <p v-if="rows.length === 0" class="empty-habits">
        {{
          selectedDate
            ? "Nothing scheduled for this date."
            : "Nothing scheduled for today."
        }}
      </p>
      <article v-for="row in rows" :key="row.key" class="habit-row">
        <h3 class="habit-name">{{ row.name }}</h3>
        <HabitDetails v-if="row.kind === 'scheduled'" :habit="row.habit" />
        <template v-else>
          <p class="mb-2 text-sm text-muted">Retained entry</p>
          <HabitLevels
            :good="row.entry.good"
            :better="row.entry.better"
            :best="row.entry.best"
          />
        </template>
        <EntryControls
          v-if="state.date <= deviceToday"
          :key="`${accountId}/${state.date}/${row.habitId}`"
          :habit-name="row.name"
          :entry="row.entry"
          :save="(edit: EntryEdit) => saveEntry(row.habitId, edit)"
          @saved="acceptEntry"
          @unauthorized="signInRequired"
        />
      </article>
    </template>
  </section>
</template>

<style scoped>
.today-view {
  margin-bottom: 40px;
}

.today-view .page-title {
  margin-bottom: 4px;
}

.today-date {
  display: block;
  margin-bottom: 20px;
  color: var(--ui-text-muted);
}

.today-error {
  display: grid;
  justify-items: start;
  gap: 12px;
}
</style>
