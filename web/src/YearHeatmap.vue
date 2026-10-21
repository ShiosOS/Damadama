<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { ApiError, habitsApi } from "./habits";
import type { Heatmap, HeatmapDate, HeatmapAnchor } from "./heatmap.schema";

type Props = {
  accountId: string | null;
  getToken: () => Promise<string | null>;
  revision: number;
};
const props = defineProps<Props>();
type HeatmapState =
  | { kind: "loading" }
  | { kind: "ready"; heatmap: Heatmap }
  | { kind: "error"; message: string };
type Load = { generation: number; accountId: string };

function currentAnchor(): HeatmapAnchor {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return {
    deviceToday: `${now.getFullYear()}-${month}-${day}`,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

const api = habitsApi(() => props.getToken());
const state = shallowRef<HeatmapState>({
  kind: "loading",
});
const selectedDate = ref<string | null>(null);
const focusedDate = ref<string | null>(null);
const selected = computed(() => {
  if (state.value.kind !== "ready") return undefined;
  return state.value.heatmap.days.find(
    (day) => day.date === selectedDate.value,
  );
});
const padding = computed(() => {
  if (state.value.kind !== "ready") return 0;
  const weekday = new Date(
    `${state.value.heatmap.start}T00:00:00Z`,
  ).getUTCDay();
  return (weekday + 6) % 7;
});
let generation = 0;
let disposed = false;
let midnightTimer: ReturnType<typeof setTimeout> | undefined;

function dateLabel(date: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(
    new Date(`${date}T12:00:00`),
  );
}

function description(day: HeatmapDate): string {
  if (day.completion === null) return "Nothing scheduled.";
  const percentage = new Intl.NumberFormat(undefined, {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(day.completion);
  const noun = day.scheduledCount === 1 ? "habit" : "habits";
  return `${day.earnedPoints} of ${day.maximumPoints} points. ${percentage} complete. ${day.scheduledCount} ${noun} scheduled.`;
}

function armMidnight(): void {
  clearTimeout(midnightTimer);
  const now = new Date();
  const midnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  );
  midnightTimer = setTimeout(
    () => void refresh(),
    midnight.getTime() - now.getTime(),
  );
}

function isCurrent(load: Load): boolean {
  return (
    !disposed &&
    load.generation === generation &&
    load.accountId === props.accountId
  );
}

function sameAnchor(first: HeatmapAnchor, second: HeatmapAnchor): boolean {
  return (
    first.deviceToday === second.deviceToday &&
    first.timeZone === second.timeZone
  );
}

async function refresh(): Promise<void> {
  const anchor = currentAnchor();
  const accountId = props.accountId;
  const current = ++generation;
  state.value = { kind: "loading" };
  selectedDate.value = null;
  focusedDate.value = null;
  armMidnight();
  if (!accountId) return;
  const load: Load = { generation: current, accountId };
  try {
    const heatmap = await api.heatmap(anchor);
    if (!isCurrent(load)) return;
    if (!sameAnchor(anchor, currentAnchor())) {
      void refresh();
      return;
    }
    state.value = { kind: "ready", heatmap };
    selectedDate.value = heatmap.end;
    focusedDate.value = heatmap.end;
  } catch (error) {
    if (!isCurrent(load)) return;
    if (!sameAnchor(anchor, currentAnchor())) {
      void refresh();
      return;
    }
    let message =
      "Could not reach the service. Check your connection and try again.";
    if (error instanceof ApiError) message = error.message;
    state.value = { kind: "error", message };
  }
}

function select(day: HeatmapDate): void {
  selectedDate.value = day.date;
}

function focus(day: HeatmapDate): void {
  focusedDate.value = day.date;
  select(day);
}

function move(event: KeyboardEvent, index: number): void {
  if (state.value.kind !== "ready") return;
  const days = state.value.heatmap.days;
  let next: number;
  switch (event.key) {
    case "ArrowUp":
      next = index - 1;
      break;
    case "ArrowDown":
      next = index + 1;
      break;
    case "ArrowLeft":
      next = index - 7;
      break;
    case "ArrowRight":
      next = index + 7;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = days.length - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  const day = days[Math.max(0, Math.min(next, days.length - 1))];
  const button = event.currentTarget;
  if (!day || !(button instanceof HTMLButtonElement)) return;
  const target = button.parentElement?.querySelector<HTMLButtonElement>(
    `[data-heatmap-date="${day.date}"]`,
  );
  target?.focus();
}

function onFocus(): void {
  void refresh();
}

function onVisible(): void {
  if (document.visibilityState === "visible") void refresh();
}

watch(
  () => [props.accountId, props.revision],
  () => void refresh(),
  { immediate: true, flush: "sync" },
);
onMounted(() => {
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisible);
});
onUnmounted(() => {
  disposed = true;
  generation++;
  clearTimeout(midnightTimer);
  window.removeEventListener("focus", onFocus);
  document.removeEventListener("visibilitychange", onVisible);
});
</script>

<template>
  <section class="year-heatmap" aria-labelledby="year-heatmap-title">
    <h2 id="year-heatmap-title" class="heatmap-title">Yearly activity</h2>
    <template v-if="accountId">
      <p v-if="state.kind === 'loading'" role="status">
        Loading yearly activity…
      </p>
      <div v-else-if="state.kind === 'error'" role="alert">
        <p>{{ state.message }}</p>
        <UButton variant="outline" @click="refresh">Retry</UButton>
      </div>
      <template v-else>
        <p class="heatmap-range">
          <time :datetime="state.heatmap.start">{{
            dateLabel(state.heatmap.start)
          }}</time>
          to
          <time :datetime="state.heatmap.end">{{
            dateLabel(state.heatmap.end)
          }}</time>
        </p>
        <p class="heatmap-instructions">
          Select a day to see its activity. Use arrow keys to move between days.
        </p>
        <div class="heatmap-scroll">
          <div class="heatmap-grid" role="group" aria-label="Daily activity">
            <span
              v-for="space in padding"
              :key="`padding-${space}`"
              aria-hidden="true"
            />
            <button
              v-for="(day, index) in state.heatmap.days"
              :key="day.date"
              type="button"
              class="heatmap-cell"
              :data-heatmap-date="day.date"
              :data-completion="day.completion"
              :aria-label="`${dateLabel(day.date)}. ${description(day)}`"
              :aria-pressed="selectedDate === day.date"
              :tabindex="focusedDate === day.date ? 0 : -1"
              :style="{ '--completion': day.completion ?? 0 }"
              @pointermove="select(day)"
              @focus="focus(day)"
              @click="select(day)"
              @keydown="move($event, index)"
            />
          </div>
        </div>
        <p class="heatmap-detail" role="status">
          <template v-if="selected"
            >{{ dateLabel(selected.date) }}.
            {{ description(selected) }}</template
          >
        </p>
        <p class="heatmap-legend">
          Good earns 1 point, Better 2, Best 3, and Rest 0.
        </p>
      </template>
    </template>
    <p v-else>Sign in to see your activity.</p>
  </section>
</template>

<style scoped>
.year-heatmap {
  min-width: 0;
  min-height: 350px;
  margin: 28px 0;
  padding: 24px 0;
  border-top: 1px solid var(--ui-border);
  border-bottom: 1px solid var(--ui-border);
}
.heatmap-title {
  font-size: 1.25rem;
  font-weight: 700;
}
.heatmap-range,
.heatmap-instructions,
.heatmap-legend {
  margin-top: 8px;
  color: var(--ui-text-muted);
  font-size: 0.875rem;
}
.heatmap-scroll {
  max-width: 100%;
  margin-top: 16px;
  padding: 3px;
  overflow-x: auto;
}
.heatmap-grid {
  display: grid;
  grid-auto-flow: column;
  grid-template-rows: repeat(7, 22px);
  grid-auto-columns: 22px;
  gap: 3px;
  width: max-content;
}
.heatmap-cell {
  position: relative;
  border: 1px solid var(--ui-border);
  border-radius: 4px;
  background: #d1d5db;
  cursor: pointer;
}
.heatmap-cell::before {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: var(--ui-primary);
  opacity: var(--completion);
  content: "";
}
.heatmap-cell:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}
.heatmap-cell[aria-pressed="true"] {
  border-color: var(--ui-text);
}
.heatmap-detail {
  min-height: 3em;
  margin-top: 12px;
}
</style>
