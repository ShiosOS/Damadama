<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { z } from "zod";
import { ApiError, habitsApi, type Habit } from "./habits";
import HabitDetails from "./HabitDetails.vue";
import HabitLevels from "./HabitLevels.vue";
import EntryControls from "./EntryControls.vue";
import type { Entry, EntryEdit } from "./entries";

const props = defineProps<{
  accountId: string | null;
  getToken: () => Promise<string | null>;
  savedRevision: number;
}>();
type TodayState =
  | { kind: "loading"; date: string }
  | { kind: "ready"; date: string; habits: Habit[]; entries: Entry[] }
  | { kind: "error"; date: string; message: string };

function localCalendarDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const api = habitsApi(() => props.getToken());
const selectedDate = ref<string | null>(null);
const deviceToday = ref(localCalendarDate());
const requestedDate = () => selectedDate.value ?? localCalendarDate();
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
const retainedEntries = computed(() => {
  const current = state.value;
  if (current.kind !== "ready") return [];
  return current.entries.filter(
    (entry) => !current.habits.some((habit) => habit.id === entry.habitId),
  );
});

function selectDate(event: Event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  const value = input.value;
  if (!z.iso.date().safeParse(value).success || value > localCalendarDate()) {
    input.value = state.value.date;
    return;
  }
  selectedDate.value = value === localCalendarDate() ? null : value;
}

function entryFor(id: string) {
  if (state.value.kind !== "ready") return undefined;
  return state.value.entries.find((entry) => entry.habitId === id);
}

function recordedHabit(habit: Habit) {
  const entry = entryFor(habit.id);
  if (!entry) return habit;
  return { ...habit, good: entry.good, better: entry.better, best: entry.best };
}

function saveEntry(habitId: string, edit: EntryEdit) {
  return api.saveEntry(habitId, state.value.date, {
    ...edit,
    deviceToday: localCalendarDate(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
}

function acceptEntry(entry: Entry) {
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

function signInRequired() {
  generation++;
  state.value = {
    kind: "error",
    date: state.value.date,
    message: "Sign in to continue.",
  };
}

function armMidnight() {
  clearTimeout(midnightTimer);
  const now = new Date();
  const midnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  );
  midnightTimer = setTimeout(checkDate, midnight.getTime() - now.getTime());
}

function checkDate() {
  deviceToday.value = localCalendarDate();
  if (requestedDate() !== state.value.date) void refresh();
  else armMidnight();
}

function onVisible() {
  if (document.visibilityState === "visible") checkDate();
}

async function refresh(mode: "all" | "schedule" = "all") {
  const current = ++generation;
  const date = requestedDate();
  const keepEntries =
    mode === "schedule" &&
    state.value.kind === "ready" &&
    state.value.date === date;
  deviceToday.value = localCalendarDate();
  if (!keepEntries) state.value = { kind: "loading", date };
  armMidnight();
  if (!props.accountId) return;
  try {
    const [habits, loadedEntries] = await Promise.all([
      api.scheduled(date),
      keepEntries ? Promise.resolve([]) : api.entries(date),
    ]);
    if (disposed || current !== generation) return;
    if (date !== requestedDate()) {
      void refresh();
      return;
    }
    const entries =
      keepEntries && state.value.kind === "ready"
        ? state.value.entries
        : loadedEntries;
    state.value = { kind: "ready", date, habits, entries };
  } catch (error) {
    if (disposed || current !== generation) return;
    if (date !== requestedDate()) {
      void refresh();
      return;
    }
    let message =
      "Could not reach the service. Check your connection and try again.";
    if (error instanceof ApiError && error.status === 401) {
      message = "Sign in to continue.";
    } else if (error instanceof ApiError) {
      message = error.message;
    }
    state.value = { kind: "error", date, message };
  }
}

watch(
  () => ({
    account: props.accountId,
    revision: props.savedRevision,
    date: selectedDate.value,
  }),
  (next, previous) => {
    const created =
      previous !== undefined &&
      next.account === previous.account &&
      next.date === previous.date &&
      next.revision !== previous.revision;
    void refresh(created ? "schedule" : "all");
  },
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
      <p
        v-if="state.habits.length === 0 && retainedEntries.length === 0"
        class="empty-habits"
      >
        {{
          selectedDate
            ? "Nothing scheduled for this date."
            : "Nothing scheduled for today."
        }}
      </p>
      <article v-for="habit in state.habits" :key="habit.id" class="habit-row">
        <h3 class="habit-name">{{ habit.name }}</h3>
        <HabitDetails :habit="recordedHabit(habit)" />
        <EntryControls
          v-if="state.date <= deviceToday"
          :key="`${accountId}/${state.date}/${habit.id}`"
          :habit-name="habit.name"
          :entry="entryFor(habit.id)"
          :save="(edit: EntryEdit) => saveEntry(habit.id, edit)"
          @saved="acceptEntry"
          @unauthorized="signInRequired"
        />
      </article>
      <article
        v-for="entry in retainedEntries"
        :key="`retained-${entry.habitId}`"
        class="habit-row"
      >
        <h3 class="habit-name">{{ entry.habitName }}</h3>
        <p class="mb-2 text-sm text-muted">Retained entry</p>
        <HabitLevels
          :good="entry.good"
          :better="entry.better"
          :best="entry.best"
        />
        <EntryControls
          v-if="state.date <= deviceToday"
          :key="`${accountId}/${state.date}/${entry.habitId}`"
          :habit-name="entry.habitName"
          :entry="entry"
          :save="(edit: EntryEdit) => saveEntry(entry.habitId, edit)"
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
