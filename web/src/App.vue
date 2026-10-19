<script setup lang="ts">
import SignedInApp from "./SignedInApp.vue";
defineProps<{ setupMessage: string | null }>();
</script>

<template>
  <UApp :toaster="null">
    <SignedInApp v-if="setupMessage === null" />
    <main v-else class="max-w-3xl mx-auto p-6 space-y-4">
      <h1 class="text-3xl font-semibold">Damadama</h1>
      <UAlert
        color="warning"
        title="Sign-in needs development configuration."
        :description="setupMessage ?? undefined"
      />
    </main>
  </UApp>
</template>
