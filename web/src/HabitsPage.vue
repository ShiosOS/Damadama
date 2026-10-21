<script setup lang="ts">
import {
  nextTick,
  onBeforeUnmount,
  reactive,
  ref,
  useTemplateRef,
  watch,
} from "vue";
import { ApiError, habitsApi } from "./habits";
import { weekdays, type Habit, type NewHabit } from "./habits.schema";
import HabitDetails from "./HabitDetails.vue";
import CheckeredD from "./CheckeredD.vue";
import TodayView from "./TodayView.vue";
import HabitEditor from "./HabitEditor.vue";
import YearHeatmap from "./YearHeatmap.vue";
import type { TodayHandle } from "./TodayView.types";

type Props = {
  accountId: string | null;
  getToken: () => Promise<string | null>;
};
const props = defineProps<Props>();
const emit = defineEmits<{ committed: [] }>();
const revision = ref(0);
const api = habitsApi(() => props.getToken());
const habits = ref<Habit[] | null>(null);
type Activity =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "saving" }
  | { kind: "error"; message: string };
const activity = ref<Activity>({ kind: "idle" });
const adding = ref(false);
const today = useTemplateRef<TodayHandle>("today");
type PendingReveal = {
  habitId: Habit["id"];
  accountGeneration: number;
  layout: ReturnType<TodayHandle["refreshAfterCreate"]>;
};
let pendingReveal: PendingReveal | null = null;
const blank = (): Omit<NewHabit, "timeZone"> => ({
  name: "",
  good: "",
  better: "",
  best: "",
  weekdays: [],
  repeatEveryWeeks: 1,
});
const form = reactive(blank());
let generation = 0;

function committed(): void {
  revision.value++;
  emit("committed");
}

function showError(error: unknown): void {
  let message =
    "Could not reach the service. Check your connection and try again.";
  if (error instanceof ApiError && error.status === 401) {
    habits.value = null;
    adding.value = false;
    message = "Sign in to continue.";
  } else if (error instanceof ApiError) {
    message = error.message;
  }
  activity.value = {
    kind: "error",
    message,
  };
}

watch(
  () => props.accountId,
  async (account) => {
    generation++;
    pendingReveal = null;
    habits.value = null;
    adding.value = false;
    Object.assign(form, blank());
    activity.value = { kind: "idle" };
    if (!account) return;
    const current = generation;
    activity.value = { kind: "loading" };
    try {
      const saved = await api.list();
      if (current !== generation) return;
      habits.value = saved;
      activity.value = { kind: "idle" };
    } catch (error) {
      if (current === generation) showError(error);
    }
  },
  { immediate: true },
);

function setDay(day: number, selected: boolean): void {
  form.weekdays = selected
    ? [...form.weekdays, day]
    : form.weekdays.filter((value) => value !== day);
}

function updateOpen(open: boolean): void {
  if (open) pendingReveal = null;
  if (activity.value.kind === "error") activity.value = { kind: "idle" };
}

function focusName(event: Event): void {
  event.preventDefault();
  document.getElementById("name")?.focus();
}

async function revealSavedHabit(): Promise<void> {
  const pending = pendingReveal;
  if (!pending) return;
  const isCurrent = await pending.layout;
  await nextTick();
  if (
    pending !== pendingReveal ||
    pending.accountGeneration !== generation ||
    adding.value
  )
    return;
  pendingReveal = null;
  if (isCurrent?.())
    document
      .getElementById(`habit-${pending.habitId}`)
      ?.scrollIntoView({ block: "nearest" });
}

async function save(): Promise<void> {
  const current = generation;
  pendingReveal = null;
  activity.value = { kind: "saving" };
  try {
    const saved = await api.create({
      ...form,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    if (current !== generation) return;
    habits.value = [...(habits.value ?? []), saved];
    committed();
    const layout = today.value?.refreshAfterCreate();
    if (layout)
      pendingReveal = { habitId: saved.id, accountGeneration: current, layout };
    adding.value = false;
    Object.assign(form, blank());
    activity.value = { kind: "idle" };
  } catch (error) {
    if (current !== generation) return;
    showError(error);
    await nextTick();
    if (current === generation && adding.value)
      document.getElementById("habit-creation-error")?.focus();
  }
}

function acceptHabit(saved: Habit): void {
  const current = habits.value?.find((habit) => habit.id === saved.id);
  if (!current || saved.revision < current.revision) return;
  habits.value = (habits.value ?? []).map((habit) =>
    habit.id === saved.id ? saved : habit,
  );
  committed();
  void today.value?.refreshAfterChange();
}

function signInRequired(): void {
  generation++;
  habits.value = null;
  adding.value = false;
  activity.value = { kind: "error", message: "Sign in to continue." };
}

onBeforeUnmount(() => {
  generation++;
  pendingReveal = null;
});
</script>

<template>
  <section v-if="accountId">
    <header class="app-header">
      <h1 class="brand" aria-label="Damadama">
        <CheckeredD /> <span>Damadama</span>
      </h1>
      <div class="flex items-center gap-3">
        <USlideover
          v-model:open="adding"
          @update:open="updateOpen"
          title="Create a habit"
          :dismissible="activity.kind !== 'saving'"
          :content="{
            onOpenAutoFocus: focusName,
            onCloseAutoFocus: revealSavedHabit,
          }"
          :ui="{
            overlay: 'z-40',
            content: 'z-50 w-full max-w-full sm:max-w-[420px]',
            body: 'overflow-y-auto',
            header: 'px-5 sm:px-6',
          }"
        >
          <UButton
            class="add-habit-button"
            :disabled="
              activity.kind === 'saving' || activity.kind === 'loading'
            "
            ><svg aria-hidden="true" viewBox="0 0 16 16" class="size-4">
              <path
                d="M8 3v10M3 8h10"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              /></svg
            ><span>Add habit</span></UButton
          >
          <template #close>
            <UButton
              aria-label="Close"
              color="neutral"
              variant="ghost"
              :disabled="activity.kind === 'saving'"
              class="absolute top-4 end-4 rounded-full"
              ><svg aria-hidden="true" viewBox="0 0 16 16" class="size-5">
                <path
                  d="m4 4 8 8M12 4l-8 8"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                /></svg
            ></UButton>
          </template>
          <template #body>
            <UAlert
              v-if="activity.kind === 'error'"
              id="habit-creation-error"
              tabindex="-1"
              role="alert"
              color="error"
              title="Request failed"
              :description="activity.message"
            />
            <form class="habit-form" @submit.prevent="save">
              <UFormField label="Name" name="name"
                ><UInput
                  id="name"
                  v-model="form.name"
                  aria-label="Name"
                  required
                  class="w-full"
              /></UFormField>
              <UFormField label="Good" name="good"
                ><UInput
                  id="good"
                  v-model="form.good"
                  aria-label="Good"
                  required
                  class="w-full"
              /></UFormField>
              <UFormField label="Better" name="better"
                ><UInput
                  id="better"
                  v-model="form.better"
                  aria-label="Better"
                  required
                  class="w-full"
              /></UFormField>
              <UFormField label="Best" name="best"
                ><UInput
                  id="best"
                  v-model="form.best"
                  aria-label="Best"
                  required
                  class="w-full"
              /></UFormField>
              <fieldset class="space-y-2">
                <legend class="font-medium">Weekdays</legend>
                <div class="flex flex-wrap gap-2">
                  <UCheckbox
                    v-for="day in weekdays"
                    :key="day.value"
                    class="weekday-choice"
                    :label="day.label"
                    :model-value="form.weekdays.includes(day.value)"
                    @update:model-value="
                      (selected: boolean | 'indeterminate') =>
                        setDay(day.value, selected === true)
                    "
                  />
                </div>
              </fieldset>
              <UFormField label="Repeat every (weeks)" name="repeatEveryWeeks">
                <UInput
                  v-model.number="form.repeatEveryWeeks"
                  aria-label="Repeat every (weeks)"
                  type="number"
                  min="1"
                  step="1"
                  required
                />
              </UFormField>
              <UButton
                block
                type="submit"
                class="rounded-full"
                :loading="activity.kind === 'saving'"
                :disabled="
                  activity.kind === 'saving' || activity.kind === 'loading'
                "
                >Save habit</UButton
              >
            </form>
          </template>
        </USlideover>
        <slot name="account" />
      </div>
    </header>
    <main class="habit-content">
      <UAlert
        v-if="activity.kind === 'error' && !adding"
        role="alert"
        color="error"
        title="Request failed"
        :description="activity.message"
      />
      <TodayView
        ref="today"
        :key="accountId ?? ''"
        :account-id="accountId"
        :get-token="getToken"
        @committed="committed"
      />
      <section aria-label="Saved habits">
        <h2 class="page-title">Your habits</h2>
        <p v-if="activity.kind === 'loading'" role="status">Loading habits…</p>
        <p v-if="habits?.length === 0" class="empty-habits">
          No habits saved yet.
        </p>
        <article
          v-for="habit in habits ?? []"
          :id="`habit-${habit.id}`"
          :key="habit.id"
          class="habit-row"
        >
          <h3 class="habit-name">{{ habit.name }}</h3>
          <HabitDetails :habit="habit" />
          <HabitEditor
            :habit="habit"
            :get-token="getToken"
            @saved="acceptHabit"
            @unauthorized="signInRequired"
          />
        </article>
      </section>
      <YearHeatmap
        :account-id="accountId"
        :get-token="getToken"
        :revision="revision"
      />
    </main>
  </section>
  <p v-else class="signed-out-message">
    Sign in to create and view your habits.
  </p>
</template>
