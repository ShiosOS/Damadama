<script setup lang="ts">
import { computed, onUnmounted, reactive, shallowRef } from "vue";
import { ApiError, habitsApi } from "./habits";
import {
  weekdays,
  type Habit,
  type HabitEdit,
  type HabitArchive,
  type NewHabit,
} from "./habits.schema";

type Props = { habit: Habit; getToken: () => Promise<string | null> };
type Emits = { saved: [habit: Habit]; unauthorized: [] };
const props = defineProps<Props>();
const emit = defineEmits<Emits>();
const api = habitsApi(() => props.getToken());
type Change =
  { kind: "edit"; input: HabitEdit } | { kind: "archive"; input: HabitArchive };
type Activity =
  | { kind: "idle" }
  | { kind: "saving"; change: Change }
  | { kind: "choice"; change: Change }
  | { kind: "error"; change: Change; message: string };
const activity = shallowRef<Activity>({ kind: "idle" });
const mode = shallowRef<"edit" | "archive" | null>(null);
const form = reactive<Omit<NewHabit, "timeZone">>({
  name: "",
  good: "",
  better: "",
  best: "",
  weekdays: [],
  repeatEveryWeeks: 1,
});
let disposed = false;
let lastMode: "edit" | "archive" = "edit";

function open(next: "edit" | "archive"): void {
  lastMode = next;
  activity.value = { kind: "idle" };
  Object.assign(form, {
    name: props.habit.name,
    good: props.habit.good,
    better: props.habit.better,
    best: props.habit.best,
    weekdays: [...props.habit.schedule.weekdays],
    repeatEveryWeeks: props.habit.schedule.repeatEveryWeeks,
  });
  mode.value = next;
}

function close(opened: boolean): void {
  if (!opened && activity.value.kind !== "saving") mode.value = null;
}

function returnFocus(event: Event): void {
  event.preventDefault();
  const trigger =
    document.getElementById(`${lastMode}-${props.habit.id}`) ??
    document.getElementById(`edit-${props.habit.id}`);
  trigger?.focus();
}

function device(): HabitArchive {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return {
    mutationId: crypto.randomUUID(),
    deviceToday: `${now.getFullYear()}-${month}-${day}`,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

function setDay(day: number, selected: boolean): void {
  form.weekdays = selected
    ? [...form.weekdays, day]
    : form.weekdays.filter((value) => value !== day);
}

const scheduleChanged = computed(
  () =>
    form.repeatEveryWeeks !== props.habit.schedule.repeatEveryWeeks ||
    [...form.weekdays].sort().join(",") !==
      [...props.habit.schedule.weekdays].sort().join(","),
);
const formDisabled = computed(
  () => activity.value.kind === "saving" || activity.value.kind === "choice",
);

function submit(): void {
  if (mode.value === "archive") {
    void send({ kind: "archive", input: device() });
    return;
  }
  const input: HabitEdit = {
    ...device(),
    name: form.name,
    good: form.good,
    better: form.better,
    best: form.best,
  };
  if (scheduleChanged.value)
    input.schedule = {
      weekdays: [...form.weekdays],
      repeatEveryWeeks: form.repeatEveryWeeks,
    };
  void send({ kind: "edit", input });
}

async function send(change: Change): Promise<void> {
  if (activity.value.kind === "saving") return;
  activity.value = { kind: "saving", change };
  try {
    const saved =
      change.kind === "edit"
        ? await api.edit(props.habit.id, change.input)
        : await api.archive(props.habit.id, change.input);
    if (disposed) return;
    emit("saved", saved);
    activity.value = { kind: "idle" };
    mode.value = null;
  } catch (error) {
    if (disposed) return;
    if (error instanceof ApiError && error.code === "today_choice_required") {
      activity.value = { kind: "choice", change };
      return;
    }
    let message =
      "Could not reach the service. Check your connection and try again.";
    if (error instanceof ApiError) message = error.message;
    activity.value = { kind: "error", change, message };
    if (error instanceof ApiError && error.status === 401) emit("unauthorized");
  }
}

function choose(todayChoice: "Keep" | "Remove"): void {
  const current = activity.value;
  if (current.kind !== "choice") return;
  if (current.change.kind === "edit") {
    void send({
      kind: "edit",
      input: { ...current.change.input, todayChoice },
    });
  } else {
    void send({
      kind: "archive",
      input: { ...current.change.input, todayChoice },
    });
  }
}

function retry(): void {
  if (activity.value.kind === "error") void send(activity.value.change);
}

onUnmounted(() => {
  disposed = true;
});
</script>

<template>
  <div class="mt-3 flex flex-wrap items-center gap-2">
    <span v-if="habit.archived" class="text-sm text-muted">Archived</span>
    <UButton
      :id="`edit-${habit.id}`"
      color="neutral"
      variant="outline"
      :aria-label="`Edit ${habit.name}`"
      @click="open('edit')"
      >Edit</UButton
    >
    <UButton
      v-if="!habit.archived"
      :id="`archive-${habit.id}`"
      color="neutral"
      variant="ghost"
      :aria-label="`Archive ${habit.name}`"
      @click="open('archive')"
      >Archive</UButton
    >
  </div>
  <USlideover
    :open="mode === 'edit'"
    title="Edit habit"
    description="Earlier entries keep their original definitions."
    :dismissible="activity.kind !== 'saving'"
    :content="{ onCloseAutoFocus: returnFocus }"
    :ui="{
      overlay: 'z-40',
      content: 'z-50 w-full max-w-full sm:max-w-[420px]',
      body: 'overflow-y-auto',
    }"
    @update:open="close"
  >
    <template #body>
      <UAlert
        v-if="activity.kind === 'error'"
        role="alert"
        color="error"
        title="Could not confirm the change"
        :description="activity.message"
        class="mb-4"
      />
      <form class="habit-form" @submit.prevent="submit">
        <UFormField label="Name" name="edit-name"
          ><UInput
            v-model="form.name"
            aria-label="Name"
            required
            class="w-full"
            :disabled="formDisabled"
        /></UFormField>
        <UFormField label="Good" name="edit-good"
          ><UInput
            v-model="form.good"
            aria-label="Good"
            required
            class="w-full"
            :disabled="formDisabled"
        /></UFormField>
        <UFormField label="Better" name="edit-better"
          ><UInput
            v-model="form.better"
            aria-label="Better"
            required
            class="w-full"
            :disabled="formDisabled"
        /></UFormField>
        <UFormField label="Best" name="edit-best"
          ><UInput
            v-model="form.best"
            aria-label="Best"
            required
            class="w-full"
            :disabled="formDisabled"
        /></UFormField>
        <fieldset class="space-y-2" :disabled="formDisabled">
          <legend class="font-medium">Weekdays</legend>
          <div class="flex flex-wrap gap-2">
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
        <UFormField label="Repeat every (weeks)" name="edit-repeat"
          ><UInput
            v-model.number="form.repeatEveryWeeks"
            aria-label="Repeat every (weeks)"
            type="number"
            min="1"
            step="1"
            required
            :disabled="formDisabled"
        /></UFormField>
        <fieldset
          v-if="activity.kind === 'choice'"
          class="space-y-3 rounded-lg border border-default p-4"
        >
          <legend class="font-medium">Today's saved entry</legend>
          <p>
            Keep today scheduled, or remove today from the schedule. Your entry
            stays in history.
          </p>
          <div class="flex flex-wrap gap-2">
            <UButton type="button" @click="choose('Keep')">Keep today</UButton
            ><UButton type="button" variant="outline" @click="choose('Remove')"
              >Remove today</UButton
            >
          </div>
        </fieldset>
        <UButton
          v-else
          type="submit"
          block
          :loading="activity.kind === 'saving'"
          :disabled="formDisabled"
          >Save changes</UButton
        >
        <UButton
          v-if="activity.kind === 'error'"
          type="button"
          variant="outline"
          block
          @click="retry"
          >Retry change</UButton
        >
      </form>
    </template>
  </USlideover>
  <UModal
    :open="mode === 'archive'"
    title="Archive habit"
    description="Past dates and saved entries stay in your history."
    :dismissible="activity.kind !== 'saving'"
    :content="{ onCloseAutoFocus: returnFocus }"
    @update:open="close"
  >
    <template #body>
      <UAlert
        v-if="activity.kind === 'error'"
        role="alert"
        color="error"
        title="Could not confirm the change"
        :description="activity.message"
        class="mb-4"
      />
      <fieldset v-if="activity.kind === 'choice'" class="space-y-3">
        <legend class="font-medium">Today's saved entry</legend>
        <p>
          Keep today scheduled, or remove today from the schedule. Your entry
          stays in history.
        </p>
        <div class="flex flex-wrap gap-2">
          <UButton @click="choose('Keep')">Keep today</UButton
          ><UButton variant="outline" @click="choose('Remove')"
            >Remove today</UButton
          >
        </div>
      </fieldset>
      <UButton
        v-else
        :loading="activity.kind === 'saving'"
        :disabled="formDisabled"
        @click="submit"
        >Archive habit</UButton
      >
      <UButton
        v-if="activity.kind === 'error'"
        variant="outline"
        class="ml-2"
        @click="retry"
        >Retry change</UButton
      >
    </template>
  </UModal>
</template>
