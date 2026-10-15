<script setup lang="ts">
import { computed, onUnmounted, ref } from "vue";
import { entryResultSchema, type DailyEntry, type EntryEdit } from "./entries";
import { ApiError } from "./habits";

const props = defineProps<{
  habitName: string;
  entry: DailyEntry | undefined;
  save: (edit: EntryEdit) => Promise<DailyEntry>;
}>();
const emit = defineEmits<{
  saved: [entry: DailyEntry];
  unauthorized: [];
}>();

type Activity =
  | { kind: "idle" }
  | { kind: "saving"; edit: EntryEdit }
  | { kind: "error"; message: string; edit: EntryEdit };
const activity = ref<Activity>({ kind: "idle" });
let disposed = false;

onUnmounted(() => {
  disposed = true;
});

const entryStatus = computed(() => {
  if (!props.entry) return "No entry recorded.";
  if (props.entry.result === "Clear") return "Entry cleared.";
  return `${props.entry.result} is saved.`;
});

async function saveEntry(edit: EntryEdit) {
  if (activity.value.kind === "saving") return;
  activity.value = { kind: "saving", edit };
  try {
    const saved = await props.save(edit);
    if (disposed) return;
    emit("saved", saved);
    activity.value = { kind: "idle" };
  } catch (error) {
    if (disposed) return;
    let message =
      "Could not reach the service. Check your connection and try again.";
    if (error instanceof ApiError) message = error.message;
    activity.value = { kind: "error", message, edit };
    if (error instanceof ApiError && error.status === 401) emit("unauthorized");
  }
}

function choose(result: EntryEdit["result"]) {
  return saveEntry({ result, editedAt: new Date().toISOString() });
}

function retry() {
  if (activity.value.kind === "error") return saveEntry(activity.value.edit);
}
</script>

<template>
  <fieldset class="mt-4 space-y-2" :aria-busy="activity.kind === 'saving'">
    <legend class="text-sm font-medium [overflow-wrap:anywhere]">
      Result for {{ habitName }}
    </legend>
    <div class="flex flex-wrap gap-2">
      <UButton
        v-for="result in entryResultSchema.options"
        :key="result"
        type="button"
        :color="entry?.result === result ? 'primary' : 'neutral'"
        :variant="entry?.result === result ? 'solid' : 'outline'"
        class="min-h-10 rounded-full px-4"
        :aria-pressed="entry?.result === result"
        :disabled="activity.kind === 'saving'"
        @click="choose(result)"
      >
        {{ result }}
      </UButton>
    </div>
    <p role="status" class="text-sm text-muted">{{ entryStatus }}</p>
    <UAlert
      v-if="activity.kind === 'error'"
      role="alert"
      color="error"
      title="Could not confirm the save"
      :description="activity.message"
    >
      <template #actions>
        <UButton
          type="button"
          color="neutral"
          variant="outline"
          class="min-h-10 rounded-full"
          @click="retry"
        >
          Retry save
        </UButton>
      </template>
    </UAlert>
  </fieldset>
</template>
