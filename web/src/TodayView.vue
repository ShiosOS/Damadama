<script setup lang="ts">
import { computed, onMounted, onUnmounted, shallowRef, watch } from "vue";
import { ApiError, habitsApi, type Habit } from "./habits";
import HabitDetails from "./HabitDetails.vue";

const props = defineProps<{
  accountId: string | null;
  getToken: () => Promise<string | null>;
  savedRevision: number;
}>();
type TodayState =
  | { kind: "loading"; date: string }
  | { kind: "ready"; date: string; habits: Habit[] }
  | { kind: "error"; date: string; message: string };

function localCalendarDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const api = habitsApi(() => props.getToken());
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
  if (localCalendarDate() !== state.value.date) void refresh();
  else armMidnight();
}

function onVisible() {
  if (document.visibilityState === "visible") checkDate();
}

async function refresh() {
  const current = ++generation;
  const date = localCalendarDate();
  state.value = { kind: "loading", date };
  armMidnight();
  if (!props.accountId) return;
  try {
    const habits = await api.scheduled(date);
    if (disposed || current !== generation) return;
    if (date !== localCalendarDate()) {
      void refresh();
      return;
    }
    state.value = { kind: "ready", date, habits };
  } catch (error) {
    if (disposed || current !== generation) return;
    if (date !== localCalendarDate()) {
      void refresh();
      return;
    }
    let message =
      "Could not reach the service. Check your connection and try again.";
    if (error instanceof ApiError) message = error.message;
    state.value = { kind: "error", date, message };
  }
}

watch(() => [props.accountId, props.savedRevision], refresh, {
  immediate: true,
  flush: "sync",
});
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
    <h2 id="today-heading" class="page-title">Today</h2>
    <time :datetime="state.date" class="today-date">{{ dateLabel }}</time>
    <p v-if="state.kind === 'loading'" role="status" class="empty-habits">
      Loading today's habits…
    </p>
    <div v-else-if="state.kind === 'error'" class="today-error">
      <UAlert
        role="alert"
        color="error"
        title="Could not load today"
        :description="state.message"
      />
      <UButton variant="outline" class="rounded-full" @click="refresh"
        >Retry</UButton
      >
    </div>
    <template v-else>
      <p v-if="state.habits.length === 0" class="empty-habits">
        Nothing scheduled for today.
      </p>
      <article v-for="habit in state.habits" :key="habit.id" class="habit-row">
        <h3 class="habit-name">{{ habit.name }}</h3>
        <HabitDetails :habit="habit" />
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
