<script setup lang="ts">
import { weekdays, type Habit } from "./habits";
defineProps<{ habit: Habit }>();
</script>

<template>
  <div class="habit-details">
    <div class="habit-tiers">
      <p>
        <span class="tier-swatch tier-good" aria-hidden="true" /><span
          ><strong>Good:</strong> {{ habit.good }}</span
        >
      </p>
      <p>
        <span class="tier-swatch tier-better" aria-hidden="true" /><span
          ><strong>Better:</strong> {{ habit.better }}</span
        >
      </p>
      <p>
        <span class="tier-swatch tier-best" aria-hidden="true" /><span
          ><strong>Best:</strong> {{ habit.best }}</span
        >
      </p>
    </div>
    <div class="habit-schedule">
      <ul class="weekday-list" aria-label="Scheduled weekdays">
        <li
          v-for="day in weekdays.filter((day) =>
            habit.schedule.weekdays.includes(day.value),
          )"
          :key="day.value"
          class="weekday-pill"
        >
          {{ day.label }}
        </li>
      </ul>
      <p>
        Every {{ habit.schedule.repeatEveryWeeks }}
        {{ habit.schedule.repeatEveryWeeks === 1 ? "week" : "weeks" }}
      </p>
    </div>
  </div>
</template>
