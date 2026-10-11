<script setup lang="ts">
import { scheduleText, type Habit } from "./habits";
defineProps<{ habit: Habit }>();
</script>

<template>
  <div class="space-y-1">
    <p>Good: {{ habit.good }}</p>
    <p>Better: {{ habit.better }}</p>
    <p>Best: {{ habit.best }}</p>
    <p>{{ scheduleText(habit.schedule) }}</p>
    <p>
      Created on {{ habit.schedule.creationDate }} ({{
        habit.schedule.timeZone
      }})
    </p>
    <p>First repeat week starts Monday {{ habit.schedule.firstWeekMonday }}</p>
  </div>
</template>
