<script setup lang="ts">
import { nextTick, reactive, ref, watch } from "vue";
import {
  ApiError,
  habitsApi,
  weekdays,
  type Habit,
  type NewHabit,
} from "./habits";
import HabitDetails from "./HabitDetails.vue";
import CheckeredD from "./CheckeredD.vue";
import TodayView from "./TodayView.vue";

const props = defineProps<{
  accountId: string | null;
  getToken: () => Promise<string | null>;
}>();
const api = habitsApi(() => props.getToken());
const habits = ref<Habit[]>([]);
type Activity =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "saving" }
  | { kind: "error"; message: string };
const activity = ref<Activity>({ kind: "idle" });
const adding = ref(false);
const savedRevision = ref(0);
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

function showError(error: unknown) {
  let message =
    "Could not reach the service. Check your connection and try again.";
  if (error instanceof ApiError && error.status === 401) {
    habits.value = [];
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
    habits.value = [];
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

function setDay(day: number, selected: boolean) {
  form.weekdays = selected
    ? [...form.weekdays, day]
    : form.weekdays.filter((value) => value !== day);
}

function clearError() {
  if (activity.value.kind === "error") activity.value = { kind: "idle" };
}

function focusName(event: Event) {
  event.preventDefault();
  document.getElementById("name")?.focus();
}

async function save() {
  const current = generation;
  activity.value = { kind: "saving" };
  try {
    const saved = await api.create({
      ...form,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    if (current !== generation) return;
    habits.value.push(saved);
    savedRevision.value++;
    adding.value = false;
    Object.assign(form, blank());
    activity.value = { kind: "idle" };
    await nextTick();
    if (current === generation)
      document
        .getElementById(`habit-${saved.id}`)
        ?.scrollIntoView({ block: "nearest" });
  } catch (error) {
    if (current !== generation) return;
    showError(error);
    await nextTick();
    if (current === generation && adding.value)
      document.getElementById("habit-creation-error")?.focus();
  }
}
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
          @update:open="clearError"
          title="Create a habit"
          :dismissible="activity.kind !== 'saving'"
          :content="{ onOpenAutoFocus: focusName }"
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
        :account-id="accountId"
        :get-token="getToken"
        :saved-revision="savedRevision"
      />
      <section aria-label="Saved habits">
        <h2 class="page-title">Your habits</h2>
        <p v-if="activity.kind === 'loading'" role="status">Loading habits…</p>
        <p v-if="habits.length === 0" class="empty-habits">
          No habits saved yet.
        </p>
        <article
          v-for="habit in habits"
          :id="`habit-${habit.id}`"
          :key="habit.id"
          class="habit-row"
        >
          <h3 class="habit-name">{{ habit.name }}</h3>
          <HabitDetails :habit="habit" />
        </article>
      </section>
    </main>
  </section>
  <p v-else class="signed-out-message">
    Sign in to create and view your habits.
  </p>
</template>
