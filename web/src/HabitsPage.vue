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

const props = defineProps<{
  accountId: string | null;
  getToken: () => Promise<string | null>;
}>();
const api = habitsApi(() => props.getToken());
const habits = ref<Habit[]>([]);
const opened = ref<Habit | null>(null);
type Activity =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "saving" }
  | { kind: "error"; message: string };
const activity = ref<Activity>({ kind: "idle" });
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
  if (error instanceof ApiError && error.status === 401) {
    habits.value = [];
    opened.value = null;
  }
  activity.value = {
    kind: "error",
    message:
      error instanceof ApiError
        ? error.status === 401
          ? "Sign in to continue."
          : error.message
        : "Could not reach the service. Check your connection and try again.",
  };
}

watch(
  () => props.accountId,
  async (account) => {
    generation++;
    habits.value = [];
    opened.value = null;
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
    Object.assign(form, blank());
    activity.value = { kind: "idle" };
    await nextTick();
    if (current === generation)
      document
        .getElementById(`habit-${saved.id}`)
        ?.scrollIntoView({ block: "nearest" });
  } catch (error) {
    if (current === generation) showError(error);
  }
}

async function open(id: Habit["id"]) {
  const current = generation;
  activity.value = { kind: "loading" };
  try {
    const habit = await api.open(id);
    if (current !== generation) return;
    opened.value = habit;
    activity.value = { kind: "idle" };
  } catch (error) {
    if (current === generation) showError(error);
  }
}
</script>

<template>
  <section v-if="accountId" class="space-y-6">
    <UAlert
      v-if="activity.kind === 'error'"
      role="alert"
      color="error"
      title="Request failed"
      :description="activity.message"
    />
    <UCard>
      <template #header
        ><h2 class="text-xl font-semibold">Create a habit</h2></template
      >
      <form class="space-y-4" @submit.prevent="save">
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
          <div class="flex flex-wrap gap-4">
            <UCheckbox
              v-for="day in weekdays"
              :key="day.value"
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
          type="submit"
          :loading="activity.kind === 'saving'"
          :disabled="activity.kind === 'saving' || activity.kind === 'loading'"
          >Save habit</UButton
        >
      </form>
    </UCard>
    <section aria-label="Saved habits" class="space-y-4">
      <h2 class="text-xl font-semibold">Your habits</h2>
      <p v-if="activity.kind === 'loading'" role="status">Loading habits…</p>
      <p v-if="habits.length === 0">No habits saved yet.</p>
      <UCard v-for="habit in habits" :id="`habit-${habit.id}`" :key="habit.id">
        <template #header
          ><UButton
            variant="link"
            :label="habit.name"
            :disabled="
              activity.kind === 'loading' || activity.kind === 'saving'
            "
            @click="open(habit.id)"
        /></template>
        <HabitDetails :habit="habit" />
      </UCard>
    </section>
    <section v-if="opened" aria-label="Opened habit">
      <UCard>
        <template #header
          ><h2 class="text-xl font-semibold">{{ opened.name }}</h2></template
        >
        <HabitDetails :habit="opened" />
      </UCard>
    </section>
  </section>
  <p v-else>Sign in to create and view your habits.</p>
</template>
