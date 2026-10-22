<script setup lang="ts">
import { computed } from "vue";
import {
  entryResultSchema,
  type Entry,
  type EntryEdit,
} from "./entries.schema";
import type { EntryActivity } from "./EntryControls.types";

type Props = {
  habitName: string;
  entry: Entry | undefined;
  activity: EntryActivity;
  save: (edit: EntryEdit) => void;
};
const props = defineProps<Props>();

const entryStatus = computed(() => {
  if (!props.entry) return "No entry recorded.";
  if (props.entry.result === "Clear") return "Entry cleared.";
  return `${props.entry.result} is saved.`;
});

function choose(result: EntryEdit["result"]): void {
  props.save({ result, editedAt: new Date().toISOString() });
}

function retry(): void {
  if (props.activity.kind === "error") props.save(props.activity.edit);
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
        class="entry-result min-h-10 rounded-full px-4"
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

<style scoped>
.entry-result[aria-pressed="true"]:hover {
  background-color: var(--ui-primary);
}
</style>
