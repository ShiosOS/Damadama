<script setup lang="ts">
defineProps<{ good: string; better: string; best: string }>();
</script>

<template>
  <div class="habit-tiers">
    <p>
      <span class="tier-swatch tier-good" aria-hidden="true" /><span
        ><strong>Good:</strong> {{ good }}</span
      >
    </p>
    <p>
      <span class="tier-swatch tier-better" aria-hidden="true" /><span
        ><strong>Better:</strong> {{ better }}</span
      >
    </p>
    <p>
      <span class="tier-swatch tier-best" aria-hidden="true" /><span
        ><strong>Best:</strong> {{ best }}</span
      >
    </p>
  </div>
</template>
