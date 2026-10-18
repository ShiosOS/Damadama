<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { z } from "zod";
import HabitsPage from "../../web/src/HabitsPage.vue";

const tokens = z
  .record(z.string(), z.string())
  .parse(await (await fetch("/fixture.json")).json());
const account = ref<string | null>(
  new URLSearchParams(location.search).get("account") ?? "owner",
);
const getToken = async (): Promise<string | null> =>
  account.value ? (tokens[account.value] ?? null) : null;
const otherAccount = (): void => {
  account.value = "other";
};
const signOut = (): void => {
  account.value = null;
};
onMounted(() => {
  window.addEventListener("fixture:other-account", otherAccount);
  window.addEventListener("fixture:sign-out", signOut);
});
onUnmounted(() => {
  window.removeEventListener("fixture:other-account", otherAccount);
  window.removeEventListener("fixture:sign-out", signOut);
});
</script>

<template>
  <UApp>
    <nav class="fixture-controls" aria-label="Test fixture account controls">
      <button @click="account = null">Fixture sign out</button>
      <button @click="account = 'other'">Fixture other account</button>
      <button @click="account = 'owner'">Fixture owning account</button>
    </nav>
    <Suspense
      ><HabitsPage :account-id="account" :get-token="getToken"
    /></Suspense>
  </UApp>
</template>

<style scoped>
.fixture-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding: 8px 24px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 0.75rem;
}
</style>
