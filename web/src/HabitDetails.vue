<script setup lang="ts">
import { weekdays, type Habit } from "./habits.schema";
import HabitLevels from "./HabitLevels.vue";
type Props = { habit: Habit };
defineProps<Props>();
</script>

<template>
  <div class="habit-details">
    <HabitLevels :good="habit.good" :better="habit.better" :best="habit.best" />
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
